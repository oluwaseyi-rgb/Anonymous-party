// Netlify Server entry point. Keep the existing Node server as the source of
// app routes and Socket.IO behavior; Netlify supplies PORT at runtime.
const server = require("../../server.js");

server.listen(Number(process.env.PORT) || 3000);
