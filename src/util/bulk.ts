import { Client } from "@elastic/elasticsearch";
import { BulkOperationContainer, BulkUpdateAction } from "@elastic/elasticsearch/lib/api/types";

class PromiseQueue {
    queue = Promise.resolve();
    async add(fn: () => Promise<void>){
        this.queue = this.queue.then(fn);
        return this.queue;
    }
}

export class BulkUpdate<T = unknown> {
    client: Client;
    index: string;
    ops: (BulkOperationContainer | BulkUpdateAction<T,Partial<T>> | T)[];
    limit: number;
    ready: Promise<boolean>;
    queue: PromiseQueue;

    constructor(client: Client, index: string, limit?: number){
        this.client = client;
        this.index = index;
        this.ops = [];
        this.limit = limit || 500
        this.ready = this.client.indices.putSettings({
            index: this.index,
            settings: {
                refresh_interval: -1
            }
        }).then( _ => true ).catch( e => {
            console.error(e);
            return false;
        })
        this.queue = new PromiseQueue();
    }

    create(id: string, doc: T){
        this.ops.push({
            create: {
                _id: id
            }
        });
        this.ops.push(doc)
        return this.sync()
    }

    update(id: string, doc: T | Partial<T>){
        this.ops.push({
            update: {
                _id: id   
            }
        })
        this.ops.push({
            doc: doc
        })
        return this.sync();
    }

    sync(){
        if( this.ops.length <= this.limit ) return;

        return this.request();
    }

    async close(){
        if(this.ops.length > 0 ) await this.request();
        
        await this.client.indices.putSettings({
            index: this.index,
            settings: {
                // @ts-ignore 2769 null is a valid value to reset the value
                refresh_interval: null
            }
        })
    }

    async request(){
        if( !(await this.ready) ) throw new Error("Could not freeze index");
        console.log("Queing request")
        let ops = this.ops;
        await this.queue.add(async () => {
            console.error(`Requesting ${ops.length/2}`)
            let sdate = new Date()
            await this.client.bulk<T,Partial<T>>({
                index: this.index,
                operations: ops
            }).then( r => {
                let edate = new Date()
                console.error(`Took ${(+edate) - (+sdate)}ms to update ${r.items.length} (errors: ${r.errors})`)
                if(r.errors){
                    console.error(r.items
                        .filter(o => o.create?.error || o.update?.error || o.delete?.error || o.index?.error)
                        .map(o => o.create?.error || o.update?.error || o.delete?.error || o.index?.error))
                }
            })
        })
        this.ops = []
    }
}