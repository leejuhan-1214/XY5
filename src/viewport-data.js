import {statistics,mercatorY,inverseMercatorY} from './observed-data.js';
export const STAC='https://planetarycomputer.microsoft.com/api/stac/v1';
export function frameFor(bounds){
  const bbox=[Math.max(-180,bounds[0]),Math.max(-85,bounds[1]),Math.min(180,bounds[2]),Math.min(85,bounds[3])];
  if(bbox[2]<=bbox[0]||bbox[3]<=bbox[1]||bbox[2]-bbox[0]>90)throw Error('현재 범위가 너무 넓습니다. 지도를 확대해 주세요.');
  const ratio=(bbox[2]-bbox[0])*Math.PI/180/(mercatorY(bbox[3])-mercatorY(bbox[1]));
  return {bbox,projection:'mercator',width:Math.max(32,Math.round(256*Math.min(1,ratio))),height:Math.max(32,Math.round(256*Math.min(1,1/ratio)))};
}
export function pixelLocation(frame,x,y){
  const [w,s,e,n]=frame.bbox;
  return [w+(x+.5)/frame.width*(e-w),inverseMercatorY(mercatorY(n)-(y+.5)/frame.height*(mercatorY(n)-mercatorY(s)))];
}
export function readNPY(buffer){
  const bytes=new Uint8Array(buffer),view=new DataView(buffer);
  if(bytes[0]!==147||new TextDecoder().decode(bytes.slice(1,6))!=='NUMPY')throw Error('위성 자료 형식 오류');
  const version=bytes[6],offset=version===1?10:12;
  const length=version===1?view.getUint16(8,true):view.getUint32(8,true);
  const header=new TextDecoder().decode(bytes.slice(offset,offset+length));
  if(!header.includes("'fortran_order': False")||!header.includes("'descr': '<u2'"))throw Error('지원하지 않는 위성 자료 형식');
  const shape=header.match(/'shape':\s*\(([^)]+)\)/)?.[1].split(',').map(x=>Number(x.trim())).filter(x=>x>0);
  if(shape?.length!==3||shape[0]!==3)throw Error('위성 온도·QA·마스크 밴드 누락');
  const count=shape.reduce((a,b)=>a*b,1),start=offset+length;
  if(buffer.byteLength!==start+count*2)throw Error('위성 자료 전송이 완료되지 않았습니다.');
  const values=new Uint16Array(count);
  for(let i=0;i<count;i++)values[i]=view.getUint16(start+i*2,true);
  return {shape,values};
}
export function temperatures(raw){
  const count=raw.shape[1]*raw.shape[2];
  return Array.from({length:count},(_,i)=>{
    const dn=raw.values[i],qa=raw.values[count+i],mask=raw.values[count*2+i];
    return mask>0&&dn>=293&&(qa&63)===0?Math.round((dn*0.00341802+149-273.15)*100)/100:null;
  });
}
export function mergeObservations(target,values,sourceIndex){
  let added=0;
  for(let i=0;i<values.length;i++)if(target.values[i]===null&&Number.isFinite(values[i])){target.values[i]=values[i];target.origins[i]=sourceIndex;added++;}
  return added;
}
export function rankScenes(items,date){
  const target=Date.parse(date+'T00:00:00Z');
  return items.filter(x=>x.assets?.lwir11&&x.assets?.qa_pixel&&/^LC0[89]_L2SP_/.test(x.id)).sort((a,b)=>{
    const distance=x=>Math.abs(Date.parse(x.properties.datetime.slice(0,10)+'T00:00:00Z')-target);
    return distance(a)-distance(b)||(a.properties['eo:cloud_cover']??100)-(b.properties['eo:cloud_cover']??100);
  });
}
export function rasterURL(item,frame){
  const params=new URLSearchParams({collection:'landsat-c2-l2',item:item.id,asset_as_band:'true',unscale:'false',resampling:'nearest',reproject:'nearest',return_mask:'true',dst_crs:'EPSG:3857'});
  params.append('assets','lwir11');params.append('assets','qa_pixel');
  return `https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/${frame.bbox.join(',')}/${frame.width}x${frame.height}.npy?${params}`;
}
async function request(url,signal){
  const response=await fetch(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(45000)])});
  if(!response.ok)throw Error(`위성 자료 서버 응답 ${response.status}`);
  return response;
}
export async function loadViewport(frame,date,signal,onProgress=()=>{}){
  const day=86400000,target=Date.parse(date+'T00:00:00Z');
  const interval=[new Date(target-32*day).toISOString(),new Date(target+33*day-1).toISOString()].join('/');
  const params=new URLSearchParams({collections:'landsat-c2-l2',bbox:frame.bbox.join(','),datetime:interval,limit:'100',query:JSON.stringify({'eo:cloud_cover':{lt:80}})});
  onProgress('현재 화면의 위성 촬영 자료 검색 중…');
  const search=await (await request(`${STAC}/search?${params}`,signal)).json();
  const candidates=rankScenes(search.features||[],date);
  const count=frame.width*frame.height;
  const result={...frame,values:Array(count).fill(null),origins:Array(count).fill(null),sources:[],partialSearch:search.links?.some(x=>x.rel==='next')||false};
  let failures=0;
  // Bound the work per camera stop; never fabricate coverage when data is absent.
  for(const item of candidates.slice(0,4)){
    onProgress(`현재 화면 분석 중 · ${item.properties.datetime.slice(0,10)}`);
    try{
      const raw=readNPY(await (await request(rasterURL(item,frame),signal)).arrayBuffer());
      if(raw.shape[1]!==frame.height||raw.shape[2]!==frame.width)throw Error('화면 격자 불일치');
      const source={id:item.id,datetime:item.properties.datetime,platform:item.properties.platform,url:`${STAC}/collections/landsat-c2-l2/items/${item.id}`};
      if(mergeObservations(result,temperatures(raw),result.sources.length))result.sources.push(source);
      if(statistics(result.values).count/count>=0.995)break;
    }catch(err){if(signal.aborted)throw err;failures++;}
  }
  if(candidates.length&&failures===Math.min(4,candidates.length))throw Error('위성 원자료를 받지 못했습니다. 잠시 후 다시 시도해 주세요.');
  result.failedScenes=failures;
  return result;
}
