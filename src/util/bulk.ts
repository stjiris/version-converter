import { Client } from "@elastic/elasticsearch";
import { BulkOperationContainer, BulkUpdateAction } from "@elastic/elasticsearch/lib/api/types";

export class BulkUpdate<T = unknown> {
    client: Client;
    index: string;
    ops: (BulkOperationContainer | BulkUpdateAction<T,Partial<T>> | T)[];
    limit: number

    constructor(client: Client, index: string, limit?: number){
        this.client = client;
        this.index = index;
        this.ops = [];
        this.limit = limit || 500
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

    async sync(){
        if( this.ops.length <= this.limit ) return;

        return this.request();
    }

    async close(){
        if(this.ops.length <= 0 ) return;

        return this.request();
    }

    async request(){
        console.error(`Requesting ${this.ops.length}`)
        let sdate = new Date()
        return await this.client.bulk<T,Partial<T>>({
            index: this.index,
            refresh: "true",
            operations: this.ops
        }).then( r => {
            let edate = new Date()
            console.error(`Took ${(+edate) - (+sdate)}ms to update ${r.items.length} (errors: ${r.errors})`)
            if(r.errors){
                console.error(r.items.filter(o => o.create?.error || o.update?.error || o.delete?.error || o.index?.error).map(o => o.create?.error))
            }
            this.ops = []
        })
    }
}