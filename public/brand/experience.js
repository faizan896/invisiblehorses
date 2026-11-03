(() => {
 const root=document.documentElement,reduced=matchMedia("(prefers-reduced-motion: reduce)"),mobile=matchMedia("(max-width:700px)");
 const horse=document.getElementById("horse-logo"),field=document.querySelector(".motion-field"),toggle=document.getElementById("motion-toggle");
 const parts=Object.fromEntries(["body","tail","neck","mane","hind-far","hind-near","front-far","front-near"].map(name=>[name,document.getElementById("horse-"+name)]));
 let paused=false,visible=true,frame=0,lastFrame=0,scheduled=0;
   function draw(index) {
    const phase = (index / 60) * Math.PI * 2;
    const swing = Math.sin(phase);
    const opposite = Math.sin(phase + Math.PI);
    parts.body.setAttribute(
      "transform",
      `translate(0 ${-4 + Math.cos(phase * 2) * 4})`,
    );
    parts["hind-near"].setAttribute(
      "transform",
      `rotate(${swing * 13} 697 598)`,
    );
    parts["hind-far"].setAttribute(
      "transform",
      `rotate(${opposite * 11} 602 606)`,
    );
    parts["front-near"].setAttribute(
      "transform",
      `rotate(${opposite * 13} 940 611)`,
    );
    parts["front-far"].setAttribute(
      "transform",
      `rotate(${swing * 10} 945 573)`,
    );
    parts.neck.setAttribute("transform", `rotate(${swing * 1.2} 941 484)`);
    parts.tail.setAttribute(
      "transform",
      `rotate(${Math.sin(phase - 0.4) * 3} 640 476)`,
    );
    parts.mane.setAttribute(
      "transform",
      `rotate(${Math.sin(phase + 0.4) * 2} 912 353)`,
    );
    horse.dataset.frame = String(index);
  }

 function requestTick(){if(!scheduled&&!document.hidden&&!paused&&!reduced.matches&&visible)scheduled=requestAnimationFrame(tick);}
 function tick(now){scheduled=0;if(now-lastFrame>=1000/60){frame=(frame+1)%60;draw(frame);lastFrame=now;}requestTick();}
 function syncMotion(){toggle.disabled=reduced.matches;toggle.textContent=reduced.matches?"Reduced motion":paused?"Play motion":"Pause motion";toggle.setAttribute("aria-pressed",String(paused||reduced.matches));if(reduced.matches)draw(0);if(scheduled&&(paused||reduced.matches||!visible)){cancelAnimationFrame(scheduled);scheduled=0;}requestTick();}
 toggle.addEventListener("click",()=>{paused=!paused;syncMotion();});reduced.addEventListener("change",syncMotion);document.addEventListener("visibilitychange",()=>{if(!document.hidden)requestTick();});
 if("IntersectionObserver" in window)new IntersectionObserver(([entry])=>{visible=entry.isIntersecting;syncMotion();},{rootMargin:"80px"}).observe(field);
 draw(0);syncMotion();
 let previewView="overview";
 const copy={overview:["Available test credits, reserved spending and requests awaiting approval.","Actual test-credit workspace overview, cropped to show available balance and request controls."],approvals:["An actual test-credit request awaiting its owner's approval.","Actual approval queue with a test-credit request and owner approval controls."],activity:["Saved request, policy and internal ledger events.","Actual activity history showing saved agent requests and decisions."]};
 function isDark(){return root.dataset.theme==="dark"||(!root.dataset.theme&&matchMedia("(prefers-color-scheme:dark)").matches);}
 function updatePreview(){const theme=isDark()?"dark":"light",image=document.getElementById("app-preview");image.src=`/product/${previewView}-desktop-${theme}.webp`;image.alt=copy[previewView][1];document.getElementById("preview-mobile").srcset=`/product/${previewView}-mobile-${theme}.webp`;document.getElementById("preview-caption").textContent=copy[previewView][0];const full=mobile.matches?`/product/${previewView}-mobile-${theme}.webp`:`/product/${previewView}-desktop-${theme}-full.webp`;document.getElementById("preview-full").href=full;document.getElementById("preview-image-link").href=full;}
 const tabs=[...document.querySelectorAll("[data-preview]")];
 function choose(tab){previewView=tab.dataset.preview;tabs.forEach(button=>{const active=button===tab;button.setAttribute("aria-selected",String(active));button.tabIndex=active?0:-1;});document.getElementById("preview-panel").setAttribute("aria-labelledby",tab.id);updatePreview();}
 tabs.forEach((tab,index)=>{tab.addEventListener("click",()=>choose(tab));tab.addEventListener("keydown",event=>{let next;if(event.key==="ArrowRight")next=(index+1)%tabs.length;else if(event.key==="ArrowLeft")next=(index+tabs.length-1)%tabs.length;else if(event.key==="Home")next=0;else if(event.key==="End")next=tabs.length-1;else return;event.preventDefault();choose(tabs[next]);tabs[next].focus();});});
 const themeButton=document.getElementById("theme");
 function updateTheme(){themeButton.textContent=isDark()?"Light mode":"Dark mode";themeButton.setAttribute("aria-label",isDark()?"Switch to light mode":"Switch to dark mode");updatePreview();}
 themeButton.addEventListener("click",()=>{root.dataset.theme=isDark()?"light":"dark";try{localStorage.setItem("payroute-theme",root.dataset.theme);}catch{}updateTheme();});matchMedia("(prefers-color-scheme:dark)").addEventListener("change",updateTheme);mobile.addEventListener("change",updatePreview);updateTheme();
 const dialog=document.getElementById("film-dialog"),video=document.getElementById("product-film");let filmTrigger;
 document.querySelectorAll("[data-play-film]").forEach(button=>button.addEventListener("click",()=>{filmTrigger=button;dialog.showModal();root.classList.add("film-open");video.play().catch(()=>{});}));
 document.getElementById("close-film").addEventListener("click",()=>dialog.close());dialog.addEventListener("click",event=>{if(event.target===dialog)dialog.close();});dialog.addEventListener("close",()=>{video.pause();root.classList.remove("film-open");filmTrigger?.focus();});
})();