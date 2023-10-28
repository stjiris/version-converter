import { TasksGetResponse } from "@elastic/elasticsearch/lib/api/types"
import { client } from "./client";


export async function waitTask(taskId: string, progressCb: (resp: TasksGetResponse) => void, sleepTimeS: number){
    let resp = await client.tasks.get({task_id: taskId});
    while(!resp.completed){
        progressCb(resp);
        await sleep(sleepTimeS);
        resp = await client.tasks.get({task_id: taskId});
    }
}


export function sleep(s: number){
    return new Promise(resolve => {
        setTimeout(resolve, s * 1000)
    })
}