# MarketLink — versão profissional de atribuição

## O que foi implementado

O vínculo financeiro deixa de depender do navegador:

**vendedor → campanha → clique → produto → pedido → pagamento confirmado → ledger → saldo**

### Endpoints principais

- `POST /api/campaigns` — cria vendedor/produto/campanha e devolve um link `/r/<campaignId>`.
- `GET /r/<campaignId>` — regista o clique no servidor e redirecciona o comprador.
- `GET /api/campaigns/<campaignId>` — devolve apenas os dados da campanha necessários para a loja.
- `POST /api/orders` — cria um pedido validando no servidor que produto e campanha pertencem ao mesmo vendedor.
- `POST /api/payments/webhook` — confirma o pagamento. É aqui que a taxa de **US$2,00** e o crédito líquido do vendedor entram no ledger.
- `GET /api/sellers/<sellerId>/wallet` — calcula o saldo a partir do ledger.

## Regra financeira

O servidor guarda valores em **centavos de USD**, e não em `float`.

Exemplo:
- produto: US$9,90
- taxa MarketLink: US$2,00
- vendedor: US$7,90

A taxa não vem do HTML nem de um valor enviado pelo comprador.

## Arranque local

Requer Node.js 20+.

```bash
npm install
npm start
```

Depois abra:

`http://localhost:3000`

O primeiro arranque cria `marketlink.sqlite`.

## Variáveis de ambiente

Copie `.env.example` para `.env` e configure:

- `PUBLIC_BASE_URL`
- `PAYMENT_WEBHOOK_SECRET`
- `PORT`

O exemplo de desenvolvimento usa `http://localhost:3000`.

## Importante para produção

Este pacote implementa a camada de atribuição e contabilidade, mas ainda não é um sistema financeiro pronto para receber dinheiro real.

Antes de produção, ligue um provedor de pagamentos real e faça a confirmação por webhook assinado. Também devem ser adicionados:

- autenticação real e sessões;
- passwords com hash forte;
- controlo de permissões por vendedor/ADM;
- validação de assinatura dos webhooks do provedor;
- HTTPS;
- rate limiting;
- proteção CSRF onde aplicável;
- KYC/AML e regras de levantamento;
- idempotência do pagamento conforme o provedor;
- base de dados gerida/backup;
- auditoria administrativa;
- política de reembolsos/chargebacks;
- preços dos produtos guardados pelo vendedor e não criados pelo formulário público;
- integração real de checkout.

**Nunca coloque PIN, OTP, CVV, password bancária ou credenciais de pagamento no HTML.**


## Publicação no Render

Consulte `DEPLOY_RENDER.md`. Esta versão inclui `render.yaml` e suporte a disco persistente para a base SQLite.
