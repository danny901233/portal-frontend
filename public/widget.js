(function(){
  var s=document.currentScript;
  if(!s)return;
  var id=s.getAttribute('data-garage-id');
  if(!id)return;
  var f=document.createElement('iframe');
  f.src='https://portal.receptionmate.co.uk/widget/'+id;
  f.allow='microphone';
  f.title='ReceptionMate Chat';
  f.style.cssText='position:fixed;bottom:0;right:0;z-index:999999;border:none;background:transparent;color-scheme:normal;width:260px;height:150px;transition:width 0.3s ease,height 0.3s ease;';
  document.body.appendChild(f);
  window.addEventListener('message',function(e){
    if(e.origin!=='https://portal.receptionmate.co.uk')return;
    if(e.data&&e.data.type==='rm-resize'){
      f.style.width=e.data.width;
      f.style.height=e.data.height;
    }
  });
})();
