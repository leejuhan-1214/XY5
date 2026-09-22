"""Fetch real Landsat ST + aligned QA. Never fill missing observations.

Requires numpy and Pillow. Raw downloaded TIFFs are cached outside the repository.
Run: python scripts/build_observations.py <cache-directory>
"""
import sys, json, hashlib
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.parse import urlencode
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from io import BytesIO
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path(sys.argv[1]) if len(sys.argv)>1 else ROOT.parent/'real-inputs'
CACHE.mkdir(parents=True, exist_ok=True)
BBOX = [126.6925639,37.4340681,126.7218288,37.4610653]
W,H = 96,108
IDS = ['LC09_L2SP_116034_20250605_02_T1','LC08_L2SP_116034_20240829_02_T1','LC09_L2SP_116034_20240602_02_T1']
def get(url):
    with urlopen(Request(url,headers={'User-Agent':'GuwolObservedAtlas/4.0'}),timeout=120) as r: return r.read()
def scene(item_id):
    source='https://planetarycomputer.microsoft.com/api/stac/v1/collections/landsat-c2-l2/items/'+item_id
    item=json.loads(get(source))
    rasters={}; provenance={}
    for asset in ['lwir11','qa_pixel']:
        url='https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/'+','.join(map(str,BBOX))+f'/{W}x{H}.tif?'+urlencode({'collection':'landsat-c2-l2','item':item_id,'assets':asset,'asset_as_band':'true','unscale':'false','resampling':'nearest','reproject':'nearest','return_mask':'false'})
        path=CACHE/f'{item_id}-{asset}.tif'
        raw=path.read_bytes() if path.exists() else get(url)
        path.write_bytes(raw)
        with Image.open(BytesIO(raw)) as im: rasters[asset]=np.asarray(im).copy()
        assert rasters[asset].shape==(H,W),rasters[asset].shape
        provenance[asset]={'url':url,'sha256':hashlib.sha256(raw).hexdigest()}
    dn=rasters['lwir11'].astype(float); qa=rasters['qa_pixel'].astype(np.uint16)
    valid=(dn>=293)&(dn<=65535)&((qa&63)==0)
    values=dn*0.00341802+149-273.15
    flat=[round(float(v),2) if ok else None for v,ok in zip(values.flat,valid.flat)]
    result={'id':item_id,'datetime':item['properties']['datetime'],'platform':item['properties']['platform'],'source':source,'assets':provenance,'values':flat}
    print(item_id,'valid',int(valid.sum()),'range',values[valid].min(),values[valid].max(),flush=True)
    return result
with ThreadPoolExecutor(max_workers=3) as pool: scenes=list(pool.map(scene,IDS))
data={'schemaVersion':1,'retrievedAt':datetime.now(timezone.utc).isoformat(),'bbox':BBOX,'width':W,'height':H,'unit':'°C','product':'Landsat Collection 2 Level-2 Surface Temperature','scale':0.00341802,'offsetK':149,'qaRejectedBits':[0,1,2,3,4,5],'resampling':'nearest','missingValue':None,'thermalNativeResolutionM':100,'scenes':scenes}
(ROOT/'data/observations.json').write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
