import { coordinationApi } from "./client.ts";
import { v4 as uuidv4 } from "uuid";
import { V1MicroTime } from "@kubernetes/client-node";
import { log } from "../log.ts";

export const NAMESPACE = 'pi-agent';
export const PODS = Array.from({length:8} , (_ , i)=>`sandbox-runner-${i}`)
const LEASE_DURATION = 45;
const INSTANCE_ID  = uuidv4();
export async function acquireLease(requestId:string , sessionId:string , toolcallId: string):Promise<string>{
    const holderIdentity = `${INSTANCE_ID}:${requestId}:${sessionId}:${toolcallId}`
    log("info", "lease.acquire.attempted", { requestId, sessionId, toolCallId: toolcallId });

    for(const pod of PODS){
        try{
            const lease = await coordinationApi.readNamespacedLease({
                name: pod,
                namespace: NAMESPACE
            });

            const holder = lease.spec?.holderIdentity;
            const acquireTime = lease.spec?.acquireTime;
            const duration = lease.spec?.leaseDurationSeconds?? LEASE_DURATION;
            const isExpired = !holder || !acquireTime || Date.now() - new Date(acquireTime as unknown as string).getTime() > duration * 1000;

            if(isExpired){
                lease.spec = {
                    ... lease.spec,
                    holderIdentity,
                    acquireTime : new V1MicroTime(),
                    renewTime: new V1MicroTime(),
                    leaseDurationSeconds:LEASE_DURATION
                };
                await coordinationApi.replaceNamespacedLease({
                    name:pod,
                    namespace:NAMESPACE,
                    body: lease
                })

                log("info", "lease.acquired", { requestId, sessionId, toolCallId: toolcallId, pod, leaseDurationSeconds: LEASE_DURATION });
                return pod;
            }

        }
        catch(e:any){
            if(e?.code === 409){
                log("warn", "lease.conflict", { requestId, sessionId, toolCallId: toolcallId, pod });
                continue;
            }
            throw e;
        }
    }
    throw new Error("NO_POD_AVAILABLE")
}
export async function releaseLease(pod:string):Promise<void>{
    const lease  = await coordinationApi.readNamespacedLease({
        name:pod,
        namespace:NAMESPACE
    });
    const { holderIdentity, acquireTime, renewTime, ...rest } = lease.spec ?? {};
    lease.spec = rest;

    await coordinationApi.replaceNamespacedLease({
        name:pod,
        namespace:NAMESPACE,
        body: lease,
    });

    log("info", "lease.released", { pod });
}
