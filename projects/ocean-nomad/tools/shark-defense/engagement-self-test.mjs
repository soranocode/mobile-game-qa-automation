// Exercises the exact decision function compiled into the live reactor; no game input.
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

export async function engagementSelfTestCode() {
  const source=await readFile(fileURLToPath(new URL('reactor.cs.txt',import.meta.url)),'utf8');
  const policy=source.match(/\/\/ ENGAGEMENT_POLICY_BEGIN\r?\n([\s\S]*?)\/\/ ENGAGEMENT_POLICY_END/)?.[1];
  if(!policy)throw Error('Live engagement decision function missing');
  return `${policy}
var cases=new[]{
    new[]{"ranged","start","aim"},new[]{"ranged","clear","shoot"},
    new[]{"ranged","blocked","reposition"},new[]{"ranged","out_of_range","wait"},
    new[]{"ranged","not_aligned","aim"},new[]{"ranged","wrong_enemy","stop"},
    new[]{"ranged","query_full","stop"},new[]{"ranged","source_unknown","stop"},
    new[]{"melee","start","melee"},new[]{"melee","blocked","melee"},
    new[]{"melee","out_of_range","melee"},new[]{"unknown","clear","stop"}};
var results=cases.Select(c=>new{family=c[0],sight=c[1],expected=c[2],actual=engagement(c[0],c[1]),passed=engagement(c[0],c[1])==c[2]}).ToArray();
return new{passed=results.All(r=>r.passed),checks=results.Length,input_sent=false,results=results};`;
}
