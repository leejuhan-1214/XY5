// Native browser fullscreen with a map-only fallback for embedded/mobile browsers.
export function setupFullscreen(button,onResize,doc=document){
  let fallback=false;
  const active=()=>Boolean(doc.fullscreenElement)||fallback;
  const sync=()=>{
    const enabled=active();
    button.setAttribute('aria-pressed',String(enabled));
    button.setAttribute('aria-label',enabled?'전체 화면 종료':'전체 화면');
    button.title=enabled?'전체 화면 종료 (Esc)':'전체 화면';
    button.textContent=enabled?'⊡':'⛶';
    doc.body.classList.toggle('map-expanded',fallback);
    onResize();
  };
  button.onclick=async()=>{
    if(fallback){fallback=false;sync();return;}
    if(doc.fullscreenElement){await doc.exitFullscreen();return;}
    try{
      if(!doc.fullscreenEnabled||!doc.documentElement.requestFullscreen)throw Error('Embedded fullscreen unavailable');
      await doc.documentElement.requestFullscreen({navigationUI:'hide'});
    }catch{fallback=true;}
    sync();
  };
  const escape=event=>{if(event.key==='Escape'&&fallback){fallback=false;sync();}};
  doc.addEventListener('fullscreenchange',sync);doc.addEventListener('keydown',escape);
  sync();
  return ()=>{doc.removeEventListener('fullscreenchange',sync);doc.removeEventListener('keydown',escape);button.onclick=null;};
}
