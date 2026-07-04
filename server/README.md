# Vila Zanotto Piri — Backend de Checkout (e.Rede + PIX Itaú + ArtaxNet)

> Mesma base do Casa Zanotto. O código é idêntico e dirigido por variáveis de
> ambiente — para o Vila, basta subir um novo serviço no Railway com as
> variáveis próprias (Artax do Vila e, conforme a conta, Itaú/Rede próprios).
> A lista completa e comentada está em [`.env.example`](.env.example).

Backend Node.js que recebe o checkout transparente do site, **cobra o pagamento
na Rede/Itaú (e.Rede)** e, **somente se o pagamento for aprovado**, cria a
reserva na **ArtaxNet**. Também recebe os **webhooks** do Artax com validação de
assinatura.

```
Cliente (checkout.html)
   │  POST /api/checkout  (dados + cartão, via HTTPS)
   ▼
Backend  ──1── GET  Artax /rooms/availability   (reconfere preço real)
         ──2── POST Rede  /transactions          (autoriza + captura)
         ──3── POST Artax /booking/create         (cria a reserva)
         ──X── POST Rede  /transactions/{tid}/refunds  (estorna se a reserva falhar)
```

## 1. Pré‑requisitos
- Node.js 18+ (testado no 24).
- Credenciais **ArtaxNet**: `ClientId` e `ClientSecret`.
- Credenciais **e.Rede**: `PV` (filiação) e `Token` de integração.

## 2. Instalação
```bash
cd server
npm install
cp .env.example .env   # no Windows: copy .env.example .env
# edite o .env com suas credenciais
npm start              # ou: npm run dev  (reinicia ao salvar)
```
O servidor sobe em `http://localhost:8080` (ou na `PORT` do `.env`).

## 3. Variáveis de ambiente (`.env`)
| Variável | Descrição |
|---|---|
| `PORT` | Porta do servidor (padrão 8080) |
| `NODE_ENV` | `development` ou `production` |
| `ALLOWED_ORIGINS` | Origens do site liberadas no CORS (separadas por vírgula) |
| `ARTAX_BASE_URL` | `https://artaxnet.com/pms-api/v1` |
| `ARTAX_CLIENT_ID` / `ARTAX_CLIENT_SECRET` | Credenciais do Artax |
| `ARTAX_WEBHOOK_TOKEN` | Token secreto que o Artax usa para assinar os webhooks |
| `REDE_BASE_URL` | Sandbox: `.../desenvolvedores/v1` · Produção: `.../erede/v1` |
| `REDE_PV` / `REDE_TOKEN` | Filiação e token da e.Rede |
| `REDE_SOFT_DESCRIPTOR` | Texto na fatura do cartão (sem acentos) |
| `MAX_INSTALLMENTS` | Máx. de parcelas no checkout |

## 4. Endpoints
| Método | Rota | Função |
|---|---|---|
| `GET` | `/api/health` | Verificação de saúde |
| `GET` | `/api/availability` | Disponibilidade (proxy seguro do Artax) |
| `POST` | `/api/checkout` | **Cobra na Rede e cria a reserva** |
| `GET` | `/api/cost-centers` | Lista centros de custo do Artax |
| `POST` | `/api/webhooks/artax` | Recebe webhooks do Artax (valida assinatura) |

### Exemplo `POST /api/checkout`
```json
{
  "arrival_date": "2026-07-10",
  "departure_date": "2026-07-12",
  "adults": 2, "kids": 0, "ages": [],
  "room_id": "301",
  "rateplan_id": 30,
  "installments": 2,
  "guest": { "first_name": "Maria", "phone": "62999991234", "email": "maria@x.com", "type": "guest" },
  "card": { "number": "5448280000000007", "holderName": "MARIA SILVA",
            "expirationMonth": 12, "expirationYear": 2030, "securityCode": "123" }
}
```
Resposta `201`:
```json
{ "booking_id": 1365372, "payment": { "tid": "...", "authorizationCode": "...", "installments": 2, "amount": 600 }, "room": { "id": "301", "name": "Duplo Superior", "rateplan_id": 30 } }
```

## 5. Conectar o site (frontend)
O `checkout.html` chama a API pela constante `API_BASE` em `checkout.js`.
Em produção, defina a URL do backend **antes** de carregar o script, por ex. no
`<head>` do `checkout.html`:
```html
<script>window.VZ_CHECKOUT_API = "https://api.vilazanottopiri.com/api";</script>
```
E registre o domínio do site em `ALLOWED_ORIGINS`.

## 6. Cartões de teste (sandbox e.Rede)
Use a `REDE_BASE_URL` de sandbox. Cartões comuns de homologação:
| Bandeira | Número | Resultado |
|---|---|---|
| Mastercard | `5448 2800 0000 0007` | Autorizado (`returnCode` `00`) |
| Visa | `4485 1340 8121 9550` | Autorizado |
> Validade futura qualquer, CVV de 3 dígitos. Confirme a lista vigente no portal
> do desenvolvedor da Rede, pois pode mudar.

## 7. Webhooks do Artax
1. No painel do Artax, configure a URL: `https://SEU_BACKEND/api/webhooks/artax`.
2. Use o mesmo `ARTAX_WEBHOOK_TOKEN` como Bearer/segredo de assinatura.
3. O endpoint valida o `Authorization: Bearer` **e** o `X-Signature`
   (HMAC‑SHA256 do corpo) em tempo constante, e responde `200` em < 5s.
4. Edite `src/webhooks.js → handleArtaxEvent` para sua regra de negócio
   (e‑mail de confirmação, baixa no banco, etc.).

## 8. Segurança / PCI (checkout transparente)
- **HTTPS obrigatório em produção** — o cartão trafega do navegador até este
  backend e dele para a Rede.
- Os dados de cartão **não são gravados** em disco, log ou banco (ver
  `src/rede.js → safeForLog`).
- Como o site captura dados de cartão, ele entra no **escopo PCI DSS** (tipicamente
  SAQ A‑EP). Recomendações: TLS atualizado, headers de segurança (já via `helmet`),
  e avaliar **3DS** (autenticação do portador) para reduzir chargebacks.
- Limites de requisição do Artax: 100/60s. O backend já tem rate limit defensivo.

## 9. Deploy (sugestão)
- **Render / Railway / Fly / VPS**: `npm start`, variáveis no painel de env.
- Garanta HTTPS (a maioria dessas plataformas já fornece).
- Aponte `ALLOWED_ORIGINS` para o domínio do site e `VZ_CHECKOUT_API` para a URL
  pública deste backend.

## 10. Observações de integração a confirmar com o Artax
- `GET /rooms/availability`: a doc cita os parâmetros "no corpo", mas é um GET —
  enviamos via **query string**. Se a sua conta exigir corpo, ajuste em
  `src/artaxnet.js → checkAvailability`.
- `price` retornado na disponibilidade é tratado como **total da estadia** por
  padrão. Se for **por diária**, basta definir `ARTAX_PRICE_MODE=per_night` no
  `.env` — o backend multiplica pelo nº de noites (tanto na exibição quanto na
  cobrança), sem mexer no código.
