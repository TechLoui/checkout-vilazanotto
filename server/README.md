# Villa Zanotto Piri — backend de checkout

API Node.js para disponibilidade e reservas no ArtaxNet, cartão na e.Rede,
PIX pela e.Rede ou pelo Itaú, confirmação por Resend e integração com a
Asksuite. A identidade pública usa **Villa Zanotto Piri**; identificadores
técnicos de pagamento usam o prefixo **VZ**.

O checkout de cartão segue esta ordem:

1. consulta novamente o preço autoritativo no Artax;
2. pré-autoriza o valor na Rede, sem captura;
3. cria a reserva no Artax;
4. captura a transação e lança o pagamento na reserva;
5. envia e-mail e webhook da Asksuite sem bloquear a resposta.

Se a criação da reserva falhar, a pré-autorização é cancelada. No PIX, a
reserva só é criada depois que o banco/adquirente confirma o pagamento.

## Execução local

Requer Node.js 18 ou superior.

```bash
cd server
npm install
cp .env.example .env
npm start
```

No Windows, use `copy .env.example .env`. O `.env` real contém segredos e não
deve ser versionado. A referência completa e comentada está em
[`.env.example`](.env.example).

## Configuração de produção

- Site padrão: `https://villazanottopiri.com`
- API Railway: `https://checkout-vilazanotto-production.up.railway.app/api`
- Cor da marca: `#F1BC0B`
- Nome público: `Villa Zanotto Piri`

Configure no Railway, no mínimo, as credenciais do Artax e do provedor de
pagamento escolhido. Pontos importantes:

- `ARTAX_CLIENT_ID` e `ARTAX_CLIENT_SECRET` são obrigatórios para consultar e
  criar reservas.
- Cartão sempre usa `REDE_CLIENT_ID`, `REDE_CLIENT_SECRET`,
  `REDE_OAUTH_URL` e `REDE_TRANSACTIONS_URL`.
- Com `PIX_PROVIDER=itau`, o mTLS exige **os dois** valores
  `ITAU_CERT_B64` e `ITAU_KEY_B64`, além das credenciais e chave PIX.
- O e-mail só é enviado quando `RESEND_API_KEY` e `RESEND_FROM` estão
  preenchidos.
- Defina `ASKSUITE_API_KEY` para consultas servidor-a-servidor. O webhook de
  conversão é opcional e só liga quando `ASKSUITE_WEBHOOK_URL` está definido.
- Em produção, mantenha `PAYMENT_SIMULATE=false`.

O código traz defaults de CORS para o domínio oficial, `www` e o checkout
legado no Netlify; localhost só entra em desenvolvimento. Quando
`ALLOWED_ORIGINS` é definido, suas origens são acrescentadas à lista padrão.

## Endpoints

| Método | Rota | Função |
|---|---|---|
| `GET` | `/api/health` | Saúde da API |
| `GET` | `/api/config` | Configuração pública (`maxInstallments` apenas) |
| `GET` | `/api/availability` | Disponibilidade e preço do Artax |
| `POST` | `/api/checkout` | Cartão: reserva e cobrança |
| `POST` | `/api/pix/create` | Cria a cobrança PIX |
| `POST` | `/api/pix/status` | Confirma PIX e cria a reserva |
| `POST` | `/api/webhooks/erede/pix` | Eventos PIX da Rede |
| `POST` | `/api/webhooks/itau/pix` | Eventos PIX do Itaú |
| `POST` | `/api/webhooks/artax` | Eventos Artax com Bearer + HMAC |
| `GET` | `/api/cost-centers` | Centros de custo do Artax (Bearer `ARTAX_WEBHOOK_TOKEN`) |

### Disponibilidade para navegador e parceiros

O navegador deve vir de uma origem permitida no CORS. Uma chamada sem header
`Origin`, como a da Asksuite, precisa enviar:

```http
X-Api-Key: <ASKSUITE_API_KEY>
```

Exemplo:

```text
GET /api/availability?arrival_date=2026-09-10&departure_date=2026-09-12&adults=2&kids=0
```

A resposta preserva as fotos do Artax. Quando não existem, a API acrescenta
URLs absolutas da galeria pública da Villa para consumo dos parceiros.

### Checkout: formato legado e formato atual

O contrato legado de uma acomodação continua aceito:

```json
{
  "arrival_date": "2026-09-10",
  "departure_date": "2026-09-12",
  "adults": 2,
  "kids": 0,
  "ages": [],
  "room_id": "301",
  "rateplan_id": 30,
  "installments": 2,
  "guest": {
    "first_name": "Maria",
    "phone": "64999991234",
    "email": "maria@example.com"
  },
  "card": {
    "number": "NUMERO_DO_CARTAO",
    "holderName": "MARIA SILVA",
    "expirationMonth": 12,
    "expirationYear": 2030,
    "securityCode": "CVV"
  }
}
```

O formato atual troca `room_id`/`rateplan_id` por:

```json
{
  "rooms": [
    { "room_id": "301", "rateplan_id": 30 },
    { "room_id": "305", "rateplan_id": 31 }
  ]
}
```

Nas respostas confirmadas, `rooms` sempre contém a lista. Quando há somente
uma acomodação, `room` também é devolvido como alias para o checkout legado.

## Frontend

Antes de carregar `checkout.js`, aponte o checkout para o Railway:

```html
<script>
  window.VZ_CHECKOUT_API = "https://checkout-vilazanotto-production.up.railway.app/api";
</script>
```

## Webhooks

- Artax: `https://checkout-vilazanotto-production.up.railway.app/api/webhooks/artax`
- Rede PIX: `https://checkout-vilazanotto-production.up.railway.app/api/webhooks/erede/pix`
- Itaú PIX: `https://checkout-vilazanotto-production.up.railway.app/api/webhooks/itau/pix`

Use tokens fortes em `ARTAX_WEBHOOK_TOKEN` e `REDE_WEBHOOK_TOKEN`. O webhook do
Itaú é revalidado consultando a cobrança pelo `txid` antes de criar a reserva.

## Limites e validação antes de publicar

- O estado de PIX pendente fica em memória. Um restart/deploy antes da
  confirmação perde esse contexto; use uma instância única e evite deploys
  durante cobranças, ou migre o estado para armazenamento persistente.
- O payload de múltiplas acomodações usa um `rateplan_id` por `room_units` e
  mantém o primeiro também no topo para compatibilidade. Homologue uma reserva
  real de duas acomodações no Artax antes de liberar esse fluxo em produção.
- O checkout transparente mantém o site no escopo PCI DSS. Produção exige
  HTTPS, controle de acesso, rotação de segredos e homologação de 3DS.
