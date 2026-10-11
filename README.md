# Sistema de votação do Grêmio Estudantil

Aplicativo web em português para organizar uma eleição estudantil, emitir códigos individuais de votação e publicar a apuração após o encerramento.

## Requisitos

- Node.js 18 ou superior
- npm

## Executar localmente

```sh
npm install
cp .env.example .env
```

Edite `.env` e escolha uma senha administrativa e dois segredos aleatórios longos e diferentes para `SESSION_SECRET` e `VOTER_CODE_SECRET`. Inicie o servidor:

```sh
npm start
```

Acesse <http://localhost:3000>. O primeiro acesso administrativo usa a senha definida em `ADMIN_PASSWORD`. A equipe organizadora pode cadastrar candidaturas e gerar códigos individuais na página `/admin`.

## Preparar e conduzir uma eleição

1. Entre na área administrativa e cadastre as candidaturas.
2. Gere códigos individuais suficientes para os participantes. Os códigos são exibidos uma única vez; copie-os e distribua cada código a uma pessoa por um canal seguro.
3. Abra a votação. Cada código pode registrar um voto e não pode ser reutilizado.
4. Encerre a votação para publicar a apuração. Os resultados não são mostrados enquanto a eleição está aberta.

O sistema armazena apenas hashes dos códigos e totais agregados por candidatura; não mantém uma ligação entre o código utilizado e a opção escolhida. Os códigos garantem uso único, mas a equipe organizadora ainda precisa controlar sua distribuição para limitar a votação às pessoas elegíveis.

## Implantação

Configure `NODE_ENV=production`, `ADMIN_PASSWORD`, `SESSION_SECRET` e `VOTER_CODE_SECRET` no ambiente do servidor. Use HTTPS, mantenha o arquivo do banco SQLite persistente e restrinja seu acesso ao processo do aplicativo. Faça cópias de segurança do banco e guarde os segredos fora dele. Para mudar o local do banco, defina `DATABASE_PATH`.

## Verificações

```sh
npm test
```
