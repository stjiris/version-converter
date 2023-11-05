import { exec, execFile, fork, spawn } from "child_process";
import { readdir } from "fs/promises";
import { join } from "path";
import { argv, argv0 } from "process";

async function showHelp(code: number, error?: string){
    if( error ){
        process.stderr.write(error);
        process.stderr.write("\n");
    }
    process.stdout.write(`Usage: ${argv0} ${__filename} <converter>\n`)
    process.stdout.write(`Populate index from a version to another.\n`)
    process.stdout.write(`Use ES_URL, ES_USER and ES_PASS environment variables to setup the elasticsearch client\n`)

    await getConverters().then(convs => {
        console.log(`Available converter values: ${convs.join(", ")}`)
    })

    process.exit(code);
}

async function main(){
    if( argv.length <= 2 ) await showHelp(1);
    await execConverter(argv[2], argv.slice(3));
}

async function getConverters(){
    let convs = await readdir(join(__dirname,"converters"));
    return convs.filter(c => c.endsWith(".js")).map(c => c.replace(".js",""))
}

async function execConverter(conv: string, args: string[]){
    let file = join(__dirname,"converters", conv+".js");
    return new Promise(resolve => {
        let proc = fork(file, args)
        proc.on("error", e => console.error(e));
        proc.on("exit", resolve)
    });
}

main().catch(e => console.error(e))