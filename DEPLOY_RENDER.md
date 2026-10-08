# MarketLink — publicação no Render

Esta versão está preparada para alojamento do backend Node.js no Render.

## 1. Criar o serviço

1. Crie uma conta em https://render.com/
2. Escolha **New → Web Service**.
3. Ligue o repositório que contém esta pasta (ou carregue o projeto através do GitHub).
4. O Render pode usar o `render.yaml` incluído neste pacote.

## 2. Configuração

O `render.yaml` já define:
- Node.js
- `npm install`
- `npm start`
- `DB_PATH=/var/data/marketlink.sqlite`
- disco persistente de 1 GB
- segredo aleatório para o webhook

Depois de criar o serviço, defina `PUBLIC_BASE_URL` com o endereço HTTPS atribuído pelo Render, por exemplo:
`https://SEU-SERVICO.onrender.com`

## 3. Administração

A área ADM continua escondida do acesso normal e é aberta pelo caminho:
`/admin`

A autenticação do ADM é feita no servidor e a sessão usa cookie HttpOnly.

## 4. Importante

Esta publicação coloca o site/backend online, mas não significa que pagamentos reais ou levantamentos estejam automaticamente ligados.

Para operar com dinheiro real ainda é necessário:
- integrar um provedor de pagamentos;
- configurar webhooks assinados;
- configurar checkout;
- implementar autenticação completa de compradores/vendedores;
- reforçar permissões e auditoria;
- configurar política de reembolsos/chargebacks;
- cumprir KYC/AML e regras locais aplicáveis.

Não coloque PIN, OTP, CVV, palavra-passe bancária ou credenciais de pagamento no site.

## 5. Limitação do plano gratuito

O serviço pode entrar em suspensão quando não está a ser utilizado e o primeiro acesso pode demorar alguns segundos. Para operação comercial contínua, use um plano adequado.

## 6. Link público

Depois do primeiro deploy, o próprio Render mostrará o URL público. Não é seguro inventar esse endereço antes do serviço ser criado.
