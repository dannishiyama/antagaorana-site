(function(){
  function init(root){
    var viewport = root.querySelector('.jz-gallery__viewport');
    var track = root.querySelector('.jz-gallery__track');
    if(!viewport || !track) return;
    var slides = track.querySelectorAll('.jz-gallery__slide');
    var prev = root.querySelector('[data-jz-prev]');
    var next = root.querySelector('[data-jz-next]');
    var curEl = root.querySelector('.jz-gallery__cur');
    var totalEl = root.querySelector('.jz-gallery__total');
    var n = slides.length;
    if(n < 1) return;
    var i = 0;
    if(totalEl) totalEl.textContent = String(n);
    function apply(){
      track.style.transform = 'translate3d(' + (-i * 100) + '%,0,0)';
      if(curEl) curEl.textContent = String(i + 1);
    }
    function go(delta){
      i = (i + delta + n * 99) % n;
      apply();
    }
    if(prev) prev.addEventListener('click', function(){ go(-1); });
    if(next) next.addEventListener('click', function(){ go(1); });
    var sx = 0, sy = 0;
    viewport.addEventListener('touchstart', function(e){
      if(!e.changedTouches||!e.changedTouches[0]) return;
      sx = e.changedTouches[0].screenX;
      sy = e.changedTouches[0].screenY;
    }, {passive:true});
    viewport.addEventListener('touchend', function(e){
      if(!e.changedTouches||!e.changedTouches[0]) return;
      var ex = e.changedTouches[0].screenX;
      var ey = e.changedTouches[0].screenY;
      if(Math.abs(ey - sy) > 52) return;
      var dx = ex - sx;
      if(dx > 60) go(-1);
      else if(dx < -60) go(1);
    }, {passive:true});
    apply();
  }
  document.querySelectorAll('[data-jz-gallery]').forEach(init);
})();
