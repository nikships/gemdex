import { MlxProcess } from './mlx-process';

const vector = '[1, ...Array(767).fill(0)]';
function fixture(body: string, timeout = 2000): MlxProcess {
    return new MlxProcess(process.execPath, ['-e', `require('readline').createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);${body}})`], timeout);
}
describe('MLX persistent pipe protocol (real subprocesses, no MLX)', () => {
    test('reuses one process, accepts split frames, drains stderr and preserves batches', async () => {
        const worker = fixture(`process.stderr.write('diagnostic');const response=JSON.stringify({id:request.id,vectors:request.texts.map(()=>${vector})})+'\\n'; process.stdout.write(response.slice(0,100)); setTimeout(()=>process.stdout.write(response.slice(100)),5);`);
        try {
            expect(await worker.request(['a', 'b'], 'document')).toHaveLength(2);
            const child = (worker as any).child;
            expect(await worker.request(['c'], 'document')).toHaveLength(1);
            expect((worker as any).child).toBe(child);
        } finally { worker.close(); }
    });
    test('sends the retrieval kind with each frame', async () => {
        const worker = fixture(`console.log(JSON.stringify(request.kind==='query'?{id:request.id,vectors:[${vector}]}:{id:request.id,error:'kind '+request.kind}))`);
        try {
            expect(await worker.request(['q'], 'query')).toHaveLength(1);
            await expect(worker.request(['d'], 'document')).rejects.toThrow('kind document');
        } finally { worker.close(); }
    });
    test.each([
        ['wrong id', `console.log(JSON.stringify({id:99,vectors:[${vector}]}))`, 'id/framing'],
        ['wrong dimension', `console.log(JSON.stringify({id:request.id,vectors:[[1]]}))`, 'vectors'],
        ['previous BGE-M3 dimension', `console.log(JSON.stringify({id:request.id,vectors:[[1,...Array(1023).fill(0)]]}))`, '768-dimensional'],
        ['zero norm', `console.log(JSON.stringify({id:request.id,vectors:[Array(768).fill(0)]}))`, 'vectors'],
        ['wrong count', `console.log(JSON.stringify({id:request.id,vectors:[]}))`, 'vectors'],
        ['malformed', `console.log('not json')`, 'JSON'],
        ['error', `console.log(JSON.stringify({id:request.id,error:'fixture error'}))`, 'fixture error'],
        ['oversized', `process.stdout.write('x'.repeat(1024*1024+1))`, 'exceeds'],
        ['crash', `process.exit(9)`, 'exited'],
    ])('rejects %s and destroys the worker', async (_name, code, message) => {
        const worker = fixture(code);
        await expect(worker.request(['a'], 'document')).rejects.toThrow(message);
        expect((worker as any).child).toBeUndefined();
    });
    test('timeouts, busy admission and explicit cleanup reject pending work', async () => {
        const worker = fixture('', 100);
        const pending = worker.request(['a'], 'document');
        await expect(worker.request(['b'], 'document')).rejects.toThrow('busy');
        await expect(pending).rejects.toThrow('timed out');
        const second = worker.request(['a'], 'document');
        worker.close();
        await expect(second).rejects.toThrow('closed');
    });
    test('bounds input before spawning', async () => {
        const worker = fixture('');
        await expect(worker.request(Array(17).fill('a'), 'document')).rejects.toThrow('1–16');
        await expect(worker.request(['x'.repeat(1024 * 1024)], 'document')).rejects.toThrow('1 MiB');
        expect((worker as any).child).toBeUndefined();
    });
});
