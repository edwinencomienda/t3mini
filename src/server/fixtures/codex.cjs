#!/usr/bin/env node
const readline = require('node:readline')
const send = (packet) => process.stdout.write(JSON.stringify(packet) + '\n')
let threadSettings
const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const packet = JSON.parse(line)
  if (packet.method === 'initialize') send({ id: packet.id, result: {} })
  if (packet.method === 'thread/start' || packet.method === 'thread/resume') {
    threadSettings = packet.params
    send({ id: packet.id, result: { thread: { id: packet.params.threadId || 'native-thread' } } })
  }
  if (packet.method === 'config/read')
    send({ id: packet.id, result: { config: { model: 'fixture-model' } } })
  if (packet.method === 'model/list')
    send({
      id: packet.id,
      result: {
        data: [
          {
            model: 'fixture-model',
            displayName: 'Fixture model',
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low' },
              { reasoningEffort: 'medium' },
              { reasoningEffort: 'high' },
            ],
            serviceTiers: [
              { id: 'default', name: 'Standard', description: 'Default speed' },
              { id: 'fast', name: 'Fast', description: '2x speed, increased usage' },
            ],
          },
        ],
        nextCursor: null,
      },
    })
  if (packet.method === 'turn/start') {
    send({ id: packet.id, result: { turn: { id: 'turn-1' } } })
    const prompt = packet.params.input[0].text
    if (prompt === 'settings') {
      send({
        method: 'item/agentMessage/delta',
        params: {
          itemId: 'settings',
          delta: JSON.stringify({ thread: threadSettings, turn: packet.params }),
        },
      })
      send({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
      return
    }
    if (prompt === 'crash') process.exit(2)
    if (prompt === 'hang') return
    if (prompt === 'approval') {
      send({
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'git status' },
      })
      return
    }
    send({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: 'Hello ' } })
    send({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: 'world.' } })
    send({
      method: 'item/completed',
      params: { item: { type: 'agentMessage', id: 'answer', text: 'Hello world.' } },
    })
    send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })
  }
  if (packet.method === 'turn/steer') {
    send({ id: packet.id, result: { turnId: packet.params.expectedTurnId } })
    send({
      method: 'item/agentMessage/delta',
      params: { itemId: 'steered', delta: JSON.stringify(packet.params) },
    })
    send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } })
  }
  if (packet.id === 'approval-1' && packet.result)
    send({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
})
