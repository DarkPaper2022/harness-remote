import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { AcpClient } from '../src/acp-client.js'

const adapter = `
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const worker = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'], {stdio:'ignore'});
process.on('SIGTERM',()=>{});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const msg=JSON.parse(line);
 if(msg.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:msg.method==='initialize'?{agentInfo:{name:'test'},authMethods:[]}: {pid:worker.pid}})+'\\n');
});
`

test('closing an isolated adapter also terminates its TERM-resistant native child', {skip:process.platform !== 'linux'}, async () => {
 const client=new AcpClient({command:process.execPath,args:['-e',adapter],processGroup:true})
 try {
  await client.start()
  const {pid}=await client.request('test/pid',{})
  assert.ok(pid>0)
  await client.closeAndWait()
  let state
  try {const stat=await readFile(`/proc/${pid}/stat`,'utf8');state=stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]} catch(e){if(e.code!=='ENOENT')throw e}
  assert.ok(state===undefined || state==='Z' || state==='X')
 } finally {await client.closeAndWait()}
})
