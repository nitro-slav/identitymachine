import{Q as e,W as t,Y as n,a as r,ct as i,i as a,n as o,q as s}from"./shell-Lz2SAe_Q.js";import{a as c,n as l,r as u,s as d,t as f}from"./econ-CJ_R0R9p.js";o(`Docs`);var p=e=>`${e/100}%`,m=[0,500,1500,3e3,4500,6e3,7500,9e3].map(e=>`<tr><td>${(e+1).toLocaleString()}</td><td>${c(d(e))} IMD</td></tr>`).join(``),h=e=>Object.entries(s[e]).map(([e,t])=>[n[+e].toLowerCase(),t/10]).sort((e,t)=>t[1]-e[1]).map(([e,t])=>`${e} ${t}%`).join(`, `),g=[0,1,2,3].map(n=>{let r=i.filter(e=>e.tier===n).length;return`<tr><td>${t(n)}</td><td>${[`70%`,`22%`,`7%`,`1%`][n]}</td><td>${e[n]}×</td><td>${r}</td></tr><tr class="sub"><td colspan="4">Shapes: ${h(n)}</td></tr>`}).join(``),_=[`common`,`uncommon`,`rare`,`legendary`,`Agent Core`].map((t,n)=>`${t} ${e[n]}`).join(`, `),v=f.map((e,t)=>`<tr><td>${t+1}</td><td>${p(e)}</td></tr>`).join(``),y=[[`Plug-pay`,l.plug,`travels with the part, and goes to the parts it plugs into`],[`Shared`,l.shared,`split across every part on the machine, by rarity`],[`Jackpot`,l.pot,`this round's jackpot, doubled by the reserve`],[`Reserve`,l.reserve,`saved to grow future jackpots`],[`Burned`,l.burn,`sent to 0x…dEaD`],[`Developer`,l.dev,``]].map(([e,t,n])=>`<tr><td>${e}</td><td>${p(t)}</td><td class="muted">${n}</td></tr>`).join(``),b=[[`Currency`,`IMD, or ETH swapped to IMD`],[`First part of a round`,`${c(d(0))} IMD, rising with every part bought`],[`Round clock`,`24 hours, +30 seconds per part placed`],[`Jackpot`,`the last ten parts placed share ${p(u)}, the rest starts the next one`],[`Shared income`,`${p(l.shared)} of every purchase, to all placed parts`],[`Plug-pay`,`${p(l.plug)} of a part's price, to the parts it plugs into`],[`Install`,`up to 50 parts in one transaction`]].map(([e,t])=>`<tr><td>${e}</td><td>${t}</td></tr>`).join(``),x=[[`Place a part`,`Tap a green spot, or drag the part close to one`,[`Enter`]],[`Move it`,`Drag it`,[`←`,`↑`,`→`,`↓`]],[`Turn it`,`Tap it, then the turn button`,[`R`]],[`Take it back`,`Tap it, then ×`,[`Delete`]],[`Install the draft`,`Press Install`,[]]].map(([e,t,n])=>`<tr><td>${e}</td><td>${t}</td><td>${n.map(e=>`<kbd>${e}</kbd>`).join(` `)}</td></tr>`).join(``),S=location.search,C=[[`Start here`,[[`overview`,`Overview`,`
      <p>Everyone builds one machine together each round, on Robinhood Chain, paying in IMD. Your parts earn while the machine runs, and the last ten placed share the jackpot. There's no owner, admin or server: the contracts run everything on this page.</p>
      <h3>Quick start</h3>
      <ol class="steps-list">
        <li><b>Buy parts.</b> Each one is a surprise, and rarer parts earn more.</li>
        <li><b>Plug them into open sockets</b> on the machine, then press Install.</li>
        <li><b>Earn.</b> Every part on the machine earns a share of each new purchase, and parts plugged into yours pay you too. When the clock runs out, the last ten placed share the jackpot.</li>
      </ol>
      <p><a class="cta" href="./index.html${S}">Open the game →</a></p>
      <h3>At a glance</h3>
      <table class="tbl kv"><tbody>${b}</tbody></table>`]]],[`Playing`,[[`buy`,`Buy parts`,`
      <p>Every part is a surprise. <a href="https://drand.love" target="_blank" rel="noopener">drand</a>, a public randomness service, picks it, and the contract checks the draw. It lands in your inventory about 10 seconds after you buy.</p>
      <p>Pay with IMD, or with ETH, which is swapped for exactly the IMD needed in the same transaction. Buy a single part, a pack of 5 or a booster box of 20.</p>
      <h3>Price</h3>
      <p>Each round starts at ${c(d(0))} IMD a part, and the price rises with every part bought in it. A new round starts over.</p>
      <div class="tbl-wrap"><table class="tbl narrow"><thead><tr><th>Part # this round</th><th>Price</th></tr></thead><tbody>${m}</tbody></table></div>`],[`place`,`Place`,`
      <p>Each round has a new machine. It grows out from a 3×3 core with twelve sockets.</p>
      <h3>Rules</h3>
      <ul>
        <li>A part must plug into at least one socket.</li>
        <li>Every edge it touches must match: socket to socket, blank to blank.</li>
        <li>The machine must always be able to grow, so you can't close off its last open outer socket. The game checks this for you.</li>
      </ul>
      <h3>Drafts and Install</h3>
      <p>Pick a part and every spot where it fits lights up green. Parts you place are a draft until you press <b>Install</b>, which places up to 50 at once with one wallet confirmation. Installing is permanent: the parts become part of that machine.</p>
      <p>Parts you don't place stay in your inventory for a later round.</p>
      <h3>Controls</h3>
      <div class="tbl-wrap"><table class="tbl controls"><thead><tr><th>To</th><th>Touch or mouse</th><th>Keyboard</th></tr></thead><tbody>${x}</tbody></table></div>`],[`earning`,`Earn`,`
      <p>A placed part earns in two ways, until its round's clock runs out. What it earned stays yours to claim at any time.</p>
      <h3>Plug-pay</h3>
      <p>Half of what a part cost travels with it. When it's placed, that half is split equally between the parts it plugs into. If it plugs into the core, that share goes to the jackpot. Plug into your own parts and you keep it.</p>
      <p>Rare parts have 4–5 sockets and legendaries 6–8, so there's more room for others to plug in and pay you.</p>
      <h3>Shared income</h3>
      <p>${p(l.shared)} of every later purchase in the round is split across all placed parts by rarity: ${_}. What you paid for a part doesn't change its share.</p>`],[`rounds`,`Rounds`,`
      <p>The clock starts at 24 hours. <b>Every part placed adds 30 seconds</b>, up to 24 hours. Buying doesn't move it.</p>
      <p>When the clock hits zero the round is over. Anyone can close it, and the next purchase does it automatically. A new machine opens right away with a full clock, ${p(1e4-u)} of the old jackpot, and the price back at ${c(d(0))} IMD.</p>
      <p>Round 1 opens after a launch countdown. Until then, anyone can add to its jackpot.</p>`],[`jackpot`,`Jackpot`,`
      <p><b>The last ten parts placed share ${p(u)} of the jackpot</b>, paid to whoever placed them. The last part placed before the clock runs out takes first place.</p>
      <table class="tbl narrow"><thead><tr><th>Place</th><th>Share</th></tr></thead><tbody>${v}</tbody></table>
      <h3>The next jackpot</h3>
      <p>The other ${p(1e4-u)}, plus any empty places, starts the next round's jackpot, so a new round never opens empty.</p>
      <h3>The reserve</h3>
      <p>The reserve takes ${p(l.reserve)} of every purchase. While it lasts, it matches the IMD that goes into the jackpot from each purchase, so jackpots grow faster.</p>`]]],[`Economy`,[[`split`,`Where your IMD goes`,`
      <p>Every purchase is split the same way:</p>
      <table class="tbl"><tbody>${y}</tbody></table>
      <p>If the buyer came through a referral link, ${p(300)} of the price moves from shared to the referrer.</p>
      <p class="muted">Once a part is placed, anyone can also sponsor the builders with <code>sponsor(amount)</code>: the IMD is split across the running machine's parts by rarity.</p>`],[`parts`,`Parts and odds`,`
      <p>A part rolls a rarity, then a shape, then a design. The odds are the same for everyone, every time. See every part on the <a href="./parts.html${S}">Parts</a> page.</p>
      <div class="tbl-wrap"><table class="tbl odds"><thead><tr><th>Rarity</th><th>Chance</th><th>Share</th><th>Designs</th></tr></thead><tbody>${g}</tbody></table></div>
      <h3>Agent Core</h3>
      <p>identity.md seat holders can claim one free Agent Core per seat. It earns shared income like a common, with no plug-pay.</p>`],[`referrals`,`Referrals`,`
      <p>Share your link from <b>You</b> and earn ${p(300)} of what the people you bring spend, whether they pay in IMD or ETH. Claim any time.</p>`]]],[`Reference`,[[`archive`,`Archive`,`
      <p>Finished machines stay on chain. The <a href="./archive.html${S}">Archive</a> draws each one so you can explore it part by part.</p>`],[`agents`,`For agents`,`
      <p>Everything is a plain contract call. <a href="./llms.txt">llms.txt</a> covers buying, revealing with drand, the wiring rules, <code>check()</code> (a dry run that also shows who a placement would pay), <code>build</code> and the round functions.</p>`],[`contracts`,`Contracts`,`
      <div class="tbl-wrap"><table class="tbl" id="addrs"><tbody><tr><td class="muted">Loading…</td></tr></tbody></table></div>`],[`risks`,`Risks`,`
      <ul>
        <li>Nobody can change, pause or undo the contracts, including us. There's no admin. Purchases cannot be cancelled or refunded.</li>
        <li>Each purchase waits on one specific drand draw. If drand never publishes it, the purchase stays unrevealed.</li>
        <li>Prices rise through a round, but a part's share depends on its rarity, not what it cost. Late parts are mostly a shot at the jackpot.</li>
        <li>Parts stop earning when the clock runs out.</li>
        <li>Bots race for the last ten places.</li>
        <li>Robinhood Chain has a single sequencer that orders transactions and sets block times. The game trusts it, like every app on the chain.</li>
        <li>Only spend what you're fine losing.</li>
      </ul>`]]]],w=C.map(([e,t])=>`<div class="docs-group"><span>${e}</span>${t.map(([e,t])=>`<a href="#${e}" data-id="${e}">${t}</a>`).join(``)}</div>`).join(``);document.getElementById(`docs`).innerHTML=`
  <details class="docs-mobile" id="docs-mobile"><summary><span>Contents</span><b id="docs-current">Overview</b></summary><nav aria-label="Contents">${w}</nav></details>
  <aside class="docs-nav"><nav aria-label="Contents">${w}</nav></aside>
  <article class="docs-body">
    <h1>How Identity Machine works</h1>
    ${C.map(([,e])=>e.map(([e,t,n])=>`
    <section id="${e}">${e===`overview`?`<h2 class="sr-only">${t}</h2>`:`<h2><a class="anchor" href="#${e}" aria-hidden="true" tabindex="-1">#</a>${t}</h2>`}${n}</section>`).join(``)).join(``)}
  </article>`;var T=[...document.querySelectorAll(`.docs-body section`)],E=document.getElementById(`docs-mobile`),D=``;function O(){let e=innerHeight/3,t=T[0].id;for(let n of T)n.getBoundingClientRect().top<=e&&(t=n.id);innerHeight+scrollY>=document.documentElement.scrollHeight-2&&(t=T[T.length-1].id),t!==D&&(D=t,document.querySelectorAll(`.docs-group a`).forEach(e=>e.classList.toggle(`on`,e.dataset.id===t)),document.getElementById(`docs-current`).textContent=T.find(e=>e.id===t).querySelector(`h2`).textContent.replace(/^#/,``))}var k=!1;addEventListener(`scroll`,()=>{k||(k=!0,requestAnimationFrame(()=>{k=!1,O()}))},{passive:!0}),addEventListener(`resize`,O),E.addEventListener(`click`,e=>{e.target.closest(`a`)&&(E.open=!1)}),O();var A=new r({board:!1});A.init().then(()=>{a(A,()=>{});let e=A.D,t=[[`Machine (buying, rounds, jackpot)`,e.machine],[`Inventory`,e.parts],[`Views`,e.views],...e.ethMinter?[[`ETH checkout`,e.ethMinter]]:[],[`drand beacon`,e.beacon],[`IMD`,e.imd]],n=t=>e.chainId===4663?`<a href="https://robin.etherscan.io/address/${t}" target="_blank" rel="noopener">${t}</a>`:t;document.querySelector(`#addrs tbody`).innerHTML=t.map(([e,t])=>`<tr><td>${e}</td><td class="mono">${n(t)}</td></tr>`).join(``)+`<tr><td>Chain</td><td class="mono">${e.chainId===4663?`Robinhood Chain (4663)`:`local test chain (${e.chainId})`}</td></tr>`}).catch(()=>{}),location.hash&&setTimeout(()=>{document.querySelector(location.hash)?.scrollIntoView(),O()},50);