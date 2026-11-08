import { app } from './app.js'
import { port } from './config.js'
import { attachPartySignaling } from './party-signaling.js'

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`MALIX backend: http://127.0.0.1:${port}`)
})
attachPartySignaling(server)
