# Villa Zanotto Piri

Site institucional e checkout direto da Villa Zanotto Piri. O conteúdo e as
fotos foram organizados a partir do site oficial, com a identidade visual em
`#F1BC0B` e integração com o backend no Railway.

## Estrutura

- `index.html`, `styles.css` e `site.js`: site institucional responsivo.
- `checkout.html`, `checkout.css` e `checkout.js`: busca, escolha da acomodação
  e pagamento, também carregados dentro do site por iframe.
- `assets/gallery`: galeria oficial em WebP.
- `server`: API Node.js para ArtaxNet, Rede, PIX Itaú, Resend e Asksuite.

O frontend aponta para:

```text
https://checkout-vilazanotto-production.up.railway.app/api
```

## Publicação

O frontend é estático. No Netlify, use esta pasta como base: o comando do
`netlify.toml` gera `dist` somente com os arquivos públicos, sem expor o código
do backend, e já inclui os cabeçalhos e o cache. No Railway, configure a raiz
do serviço como `server`, instale com `npm install` e inicie com `npm start`.

Depois de atualizar o backend no Railway, valide:

```text
GET /api/health
GET /api/config
GET /api/availability?arrival_date=2026-09-10&departure_date=2026-09-12&adults=2&kids=0
```

As credenciais ficam exclusivamente nas variáveis do Railway. Além das
credenciais Rede/Itaú e `MAX_INSTALLMENTS`, a reserva depende de
`ARTAX_CLIENT_ID` e `ARTAX_CLIENT_SECRET`. PIX Itaú por mTLS exige também
`ITAU_CERT_B64`; envio de e-mail exige `RESEND_FROM` junto de
`RESEND_API_KEY`. A lista completa e comentada está em
[`server/.env.example`](server/.env.example).

Mais detalhes do contrato, webhooks e cuidados de homologação estão em
[`server/README.md`](server/README.md).
