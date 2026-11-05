/* 시간별 캐시와 이후 집계를 KST 3시간 칸으로 연결. 서버 자료는 수정하지 않는다. */
(function(root){
  'use strict';
  var H=3600000;
  function slotEnd(t){return Math.floor((t-H)/ (3*H))*(3*H)+3*H;}
  function add(a,b){return a==null||b==null?null:a+b;}
  function minimum(a,b){return a==null?b:b==null?a:Math.min(a,b);}
  function maximum(a,b){return a==null?b:b==null?a:Math.max(a,b);}
  function combine(data){
    if(!data || data.status!=='ok' || !data.upper) return [];
    var upper=data.upper,sr=upper.series||{},start=Date.parse(upper.start_at),groups={};
    if(!Number.isFinite(start)) return [];
    function insert(b){
      var key=slotEnd(Date.parse(b.first_at)),old=groups[key];
      if(!old){groups[key]=Object.assign({},b);return;}
      old.last_at=new Date(Math.max(Date.parse(old.last_at),Date.parse(b.last_at))).toISOString();
      old.hours+=b.hours;
      ['snow','snow_hi','pcp','pcp_hi'].forEach(function(k){old[k]=add(old[k],b[k]);});
      old.tmin=minimum(old.tmin,b.tmin);old.pop=maximum(old.pop,b.pop);
    }
    for(var i=0;i<24;i++){
      var t=start+i*H,iso=new Date(t).toISOString();
      var snow=sr.s && sr.s[i],rain=sr.p && sr.p[i];
      insert({first_at:iso,last_at:iso,hours:1,snow:snow==null?null:snow,snow_hi:snow==null?null:snow+((sr.sq||[])[i]?1:0),pcp:rain==null?null:rain,pcp_hi:rain==null?null:rain+((sr.pq||[])[i]?1:0),tmin:sr.t && sr.t[i],pop:sr.r && sr.r[i]});
    }
    (data.tail && data.tail.bins || []).forEach(function(b){
      // 정성·혼합·결측은 양으로 확정할 수 없으므로 시간 칸 자체를 넣지 않는다.
      if(b.snow==null || b.pcp==null || (b.code_hours||0)>0 || Date.parse(b.first_at)<start+24*H) return;
      insert(b);
    });
    return Object.keys(groups).sort(function(a,b){return +a-+b;}).map(function(k){
      var b=groups[k];b.expected_hours=(Date.parse(b.last_at)-Date.parse(b.first_at))/H+1;
      b.partial=b.hours<3 || b.hours<b.expected_hours;return b;
    }).filter(function(b){return b.snow!=null && b.pcp!=null;});
  }
  var api={combine:combine};
  if(typeof module!=='undefined' && module.exports) module.exports=api;else root.ForecastSeries=api;
})(typeof window!=='undefined'?window:this);
