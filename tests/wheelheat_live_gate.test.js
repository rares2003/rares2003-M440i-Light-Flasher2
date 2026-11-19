'use strict';
// Offline safety unit test. No vehicle writes are made.
const assert = require('assert');
const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
    if (request === './kit/diag' && parent && parent.filename.endsWith('/g21_wheelheat/safe_diag.js'))
        return require.resolve('../kit/runtime/diag');
    return originalResolve.call(this, request, parent, ...rest);
};
const { SafeDiag } = require('../apps/g21_wheelheat/safe_diag');
Module._resolveFilename = originalResolve;

async function run() {
    let permit = false, writes = 0;
    const ctl = new SafeDiag({settings:{get:()=>permit},signals:{},log:{info(){},warn(){}}},0x40,0xD074);
    ctl.diag.p={};ctl.diag.available=true;
    const wheel=[0xD0,0x74,60],driver=[0xE4,0x32,3,60],passenger=[0xE4,0x30,3,60];
    const errors=new Map();
    ctl.diag.physical=async (_target,sid,data)=>{
        const did=data[0]*256+data[1];
        if(sid===0x22)return errors.has(did)?[0x7F,0x22,errors.get(did)]:[0x62,data[0],data[1],1,0,0x44,2,1];
        if(sid===0x2E){writes++;return [0x6E,data[0],data[1]];}
        throw Error('unexpected service');
    };
    const motion=speed=>{ctl.speed=speed;ctl.speedAt=Date.now();};
    assert.equal(await ctl.read(0xD074),true);
    assert.equal(await ctl.autoWrite(wheel,'wheel'),false,'explicit consent required');
    permit=true;
    assert.equal(await ctl.autoWrite(wheel,'wheel'),false,'unknown speed blocked');
    motion(0);
    assert.equal(await ctl.autoWrite(driver,'driver'),false,'wheel read cannot authorize seat');
    errors.set(0xE432,0x22);errors.set(0xE430,0x22);
    assert.equal(await ctl.read(0xE432),false);
    assert.equal(ctl.readbacks[0xE432].nrc,0x22);
    assert.equal(ctl.readRetryable,true);
    assert.equal(await ctl.read(0xE430),false);
    assert.equal(await ctl.autoWrite(driver,'driver'),false);
    assert.equal(await ctl.autoWrite(passenger,'passenger'),false);
    assert.equal(await ctl.autoWrite(wheel,'wheel'),true,'G05 seat rejection does not block wheel');
    assert.equal(writes,1);
    assert.equal(ctl.verifiedFor(0xD074),false);
    errors.delete(0xE432);errors.delete(0xE430);errors.set(0xD074,0x25);
    ctl.lastWriteAt=0;motion(10);
    assert.equal(await ctl.read(0xD074),false);
    assert.equal(ctl.lastReadNrc,0x25);
    assert.equal(ctl.readRetryable,true);
    assert.match(ctl.info,/no response from subnet component/);
    assert.equal(await ctl.read(0xE432),true);
    assert.equal(await ctl.autoWrite(driver,'driver'),true,'G21 seat independent of unavailable wheel');
    assert.equal(writes,2);
    ctl.lastWriteAt=0;
    assert.equal(await ctl.autoWrite(passenger,'passenger'),false,'target read required');
    errors.set(0xE430,0x31);
    assert.equal(await ctl.read(0xE430),false);
    assert.equal(ctl.readRetryable,false);
    errors.delete(0xE430);
    assert.equal(await ctl.read(0xE430),true);
    ctl.speedAt=Date.now()-10000;
    assert.equal(await ctl.autoWrite(passenger,'passenger'),false,'stale speed');
    motion(0);ctl.verifiedAt[0xE430]=Date.now()-61000;
    assert.equal(await ctl.autoWrite(passenger,'passenger'),false,'stale read');
    assert.equal(await ctl.read(0xE430),true);
    assert.equal(await ctl.autoWrite(passenger,'passenger'),true);
    assert.equal(writes,3);
    console.log('OK: independent G21/G05 gates, NRC 22/25/31, consent, freshness');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
