// PAPER TRADING ONLY. No auth, no orders. Public market data only.
const fs=require('fs'),http=require('http'),path=require('path');
const K='https://api.elections.kalshi.com/trade-api/v2',SERIES='KXBTC15M',PORT=8787,START=44.82;
const D=__dirname,STATE=path.join(D,'public/state.json'),LOG=path.join(D,'trades.jsonl'),CSV=path.join(D,'trades.csv');
fs.mkdirSync(path.join(D,'public'),{recursive:true});
const log=m=>console.log(new Date().toISOString(),m);
const j=async u=>{const r=await fetch(u,{headers:{'User-Agent':'paper-bot'}});if(!r.ok)throw new Error(u+' '+r.status);return r.json()};
const AG=['Momentum','MeanReversion','PriceEdge','Trend1h','Contrarian'];
let S=fs.existsSync(STATE)?JSON.parse(fs.readFileSync(STATE)):{agents:Object.fromEntries(AG.map(a=>[a,{bankroll:START,wins:0,losses:0,pnl:0,last:null}])),open:[],trades:[],market:null,spot:null,decided:{}};
const fee=(c,p)=>Math.ceil(0.07*c*p*(1-p)*100)/100;
function rec(o){fs.appendFileSync(LOG,JSON.stringify(o)+'\n');if(!fs.existsSync(CSV))fs.writeFileSync(CSV,'time,type,agent,ticker,side,price,contracts,cost,fee,result,pnl,reason\n');
fs.appendFileSync(CSV,[o.time,o.type,o.agent,o.ticker,o.side,o.price,o.contracts,o.cost,o.fee,o.result||'',o.pnl??'',JSON.stringify(o.reason||'')].join(',')+'\n');S.trades.unshift(o);S.trades=S.trades.slice(0,300)}
const Phi=x=>{const t=1/(1+.2316419*Math.abs(x)),d=.3989423*Math.exp(-x*x/2),p=d*t*(.3193815+t*(-.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return x>0?1-p:p};
async function cycle(){
 const sp=+(await j('https://api.coinbase.com/v2/prices/BTC-USD/spot')).data.amount;
 const c=await j('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60');// newest first [t,lo,hi,open,close,vol]
 const cl=c.slice(0,90).map(x=>x[4]);
 const ms=(await j(`${K}/markets?series_ticker=${SERIES}&status=open`)).markets.sort((a,b)=>a.close_time<b.close_time?-1:1);
 const m=ms[0];S.spot=sp;S.updated=new Date().toISOString();
 if(m){S.market={ticker:m.ticker,strike:m.floor_strike,close:m.close_time,open:m.open_time,yes_bid:+m.yes_bid_dollars,yes_ask:+m.yes_ask_dollars,no_bid:+m.no_bid_dollars,no_ask:+m.no_ask_dollars};
  try{const ob=await j(`${K}/markets/${m.ticker}/orderbook`);S.market.orderbook_ok=true;S.market.ob=ob.orderbook_fp||ob.orderbook}catch(e){S.market.orderbook_ok=false}}
 // settle
 for(const p of [...S.open]){if(Date.now()<Date.parse(p.close)+30e3)continue;let res='';
  try{res=(await j(`${K}/markets/${p.ticker}`)).market.result}catch(e){}
  let src='kalshi';if(!res&&Date.now()>Date.parse(p.close)+15*60e3&&p.strike){res=sp>=p.strike?'yes':'no';src='spot-fallback'}
  if(!res)continue;const win=res===p.side,pay=win?p.contracts:0,pnl=+(pay-p.cost-p.fee).toFixed(2),a=S.agents[p.agent];
  a.bankroll=+(a.bankroll+pay).toFixed(2);a.pnl=+(a.pnl+pnl).toFixed(2);win?a.wins++:a.losses++;
  rec({time:new Date().toISOString(),type:'SETTLE',agent:p.agent,ticker:p.ticker,side:p.side,price:p.price,contracts:p.contracts,cost:p.cost,fee:p.fee,result:res+'('+src+')',pnl});S.open=S.open.filter(x=>x!==p)}
 if(!m||!m.floor_strike||S.decided[m.ticker])return save();
 const left=(Date.parse(m.close_time)-Date.now())/60e3;if(left<2)return save();
 const ya=+m.yes_ask_dollars,na=+m.no_ask_dollars;
 const r=[];for(let i=0;i<cl.length-1;i++)r.push(Math.log(cl[i]/cl[i+1]));const sd=Math.sqrt(r.reduce((s,x)=>s+x*x,0)/r.length);
 const pU=Phi(Math.log(sp/m.floor_strike)/(sd*Math.sqrt(Math.max(left,.5))));
 const m5=sp-cl[5],sma60=cl.slice(0,60).reduce((s,x)=>s+x,0)/60,h1=sp-cl[60];
 const dec={
  Momentum:m5>0?['yes',`5m move +$${m5.toFixed(0)}`]:['no',`5m move -$${(-m5).toFixed(0)}`],
  MeanReversion:Math.abs(sp-sma60)/sma60<0.0008?[null,'near 60m mean']:sp>sma60?['no',`spot $${(sp-sma60).toFixed(0)} above 60m SMA`]:['yes',`spot $${(sma60-sp).toFixed(0)} below 60m SMA`],
  PriceEdge:pU-ya>0.05?['yes',`model P(up)=${(pU*100).toFixed(0)}% vs ask ${(ya*100).toFixed(0)}c`]:(1-pU)-na>0.05?['no',`model P(down)=${((1-pU)*100).toFixed(0)}% vs ask ${(na*100).toFixed(0)}c`]:[null,`no edge: P(up)=${(pU*100).toFixed(0)}%, yes ${(ya*100).toFixed(0)}c/no ${(na*100).toFixed(0)}c`],
  Trend1h:h1>0?['yes',`1h trend +$${h1.toFixed(0)}`]:['no',`1h trend -$${(-h1).toFixed(0)}`],
  Contrarian:ya>0.6?['no','crowd heavy YES, fade']:na>0.6?['yes','crowd heavy NO, fade']:[null,'crowd balanced'],
 };
 for(const a of AG){let[side,why]=dec[a];const ag=S.agents[a];let veto='';
  if(side){const pr=side==='yes'?ya:na;
   if(!(pr>0.03&&pr<0.97))veto='Risk: price extreme/no liquidity';else if(ag.bankroll<1)veto='Risk: bankroll too low';
   else{const n=Math.floor(0.10*ag.bankroll/pr);if(n<1)veto='Risk: 10% cap < 1 contract';else{
    const cost=+(n*pr).toFixed(2),f=fee(n,pr);ag.bankroll=+(ag.bankroll-cost-f).toFixed(2);
    const t={time:new Date().toISOString(),type:'BUY',agent:a,ticker:m.ticker,side,price:Math.round(pr*100),contracts:n,cost,fee:f,reason:why,strike:m.floor_strike,close:m.close_time,spot:sp};
    rec(t);S.open.push({...t,price:pr});}}}
  ag.last={ticker:m.ticker,call:side&&!veto?'BUY '+side.toUpperCase():'SKIP',reason:why+(veto?' — '+veto:''),time:new Date().toISOString()};
  if(!side||veto)rec({time:ag.last.time,type:'SKIP',agent:a,ticker:m.ticker,reason:ag.last.reason});}
 S.decided[m.ticker]=1;S.model={pUp:pU,sigma1m:sd};log('decided '+m.ticker);save()}
function save(){const t=Object.values(S.agents);S.portfolio={start:START*AG.length,bankroll:+t.reduce((s,a)=>s+a.bankroll,0).toFixed(2),pnl:+t.reduce((s,a)=>s+a.pnl,0).toFixed(2),open:S.open.length};
 fs.writeFileSync(STATE,JSON.stringify(S,null,1))}
async function loop(){try{await cycle()}catch(e){log('ERR '+e.message)}setTimeout(loop,30e3)}
http.createServer((q,r)=>{const f=q.url.startsWith('/state.json')?'state.json':'index.html';
 r.writeHead(200,{'Content-Type':f.endsWith('json')?'application/json':'text/html','Cache-Control':'no-store'});r.end(fs.readFileSync(path.join(D,'public',f)))}).listen(PORT,()=>log('dash http://localhost:'+PORT));
loop();
