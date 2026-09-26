import {runResearchExperiment,predictAtAcquisition,validationMetrics} from './research-model.js';

self.onmessage = ({data}) => {
  const {id,task,dataset,options,scenes,weatherDates} = data;
  try {
    if(task === 'experiment') self.postMessage({id,task,result:runResearchExperiment(dataset,options)});
    else if(task === 'validation') {
      const rows=[];
      for(const scene of scenes) {
        const weather=weatherDates.find(item=>item.date===scene.date&&item.status==='available');
        if(!weather) {rows.push({date:scene.date,id:scene.id,unavailable:true,reason:'같은 날짜의 기상 자료 없음'});continue;}
        const prediction=predictAtAcquisition(dataset,{weather:weather.hourly,date:scene.date,datetime:scene.datetime});
        const values=prediction.values;
        rows.push({date:scene.date,id:scene.id,hour:prediction.hour,...validationMetrics(values,scene.values,dataset.surface.insideBoundary),source:scene.source,weatherSource:weather.source});
      }
      self.postMessage({id,task,result:rows});
    } else throw Error('알 수 없는 연구 계산입니다.');
  } catch(error) {self.postMessage({id,task,error:error.message||String(error)});}
};
