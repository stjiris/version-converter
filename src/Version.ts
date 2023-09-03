import { PACKAGE_NAMES } from "./create";

type Version = {
    JurisprudenciaVersion: string;
    JurisprudenciaProperties: Record<string, any>;
};

export async function getVersions(): Promise<Version[]> {
    let versions = [];
    for (let name of PACKAGE_NAMES) {
        versions.push(import(name));
    }
    return Promise.all(versions);
}

export async function getVersion(v: string){
    let filtered = (await getVersions()).filter(c => c.JurisprudenciaVersion === v);
    if( filtered.length == 0 || filtered.length > 1 ) return null;
    
    return filtered[0];
}
