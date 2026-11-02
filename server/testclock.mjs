// Preloaded into the server by server.test.mjs (never in production): the server's clock runs ahead by whatever the test
// sends it, so a test moves time on instead of waiting for it. Each message is answered once it applies.
const now = Date.now
let ahead = 0
Date.now = () => now() + ahead
process.on('message', (ms) => ((ahead += ms), process.send(ahead)))
