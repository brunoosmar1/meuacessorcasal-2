// Ponto de entrada para a Vercel. O `server.js` exporta o app do Express (sem
// chamar app.listen quando importado, só quando rodado diretamente com `node
// src/server.js`) — aqui só repassamos esse app para o runtime serverless da Vercel,
// que sabe como transformar isso numa função HTTP.
module.exports = require("../src/server.js");
