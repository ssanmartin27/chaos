import GUI from 'https://cdn.jsdelivr.net/npm/lil-gui@0.19/+esm';

async function main() {
    const adapter = await navigator.gpu?.requestAdapter();
    const device = await adapter?.requestDevice();
    if (!device) {
        fail('need a browser that supports webgpu');
        return;
    }

    const uniforms = {
        rez: 1024,
        step: 0,
    };

    const MAX_K = 10;
    const transitionTable = new Uint32Array(Math.pow(MAX_K, 3));

    const settings = {
        k: 5,
        lambda: 0.5,
        weakQuiescence: true,
        strongQuiescence: true,
        isotropy: true,
        reset: () => {
            updateTransitionTable();
            reset();
        }
    };

    function updateTransitionTable() {
        const k = settings.k;
        const totalRules = Math.pow(k, 3);

        for (let i = 0; i < transitionTable.length; i++) transitionTable[i] = 0;

        if (!settings.isotropy) {
            for (let i = 0; i < totalRules; i++) {
                if (Math.random() > settings.lambda)
                    transitionTable[i] = 0;
                else
                    transitionTable[i] = Math.floor(Math.random() * (k - 1)) + 1;
            }
        }
        else {
            for (let c = 0; c < k; c++) {
                for (let l = 0; l < k; l++) {
                    for (let r = l; r < k; r++) {
                        let index = l * (k * k) + c * k + r;
                        let mirrorIndex = r * (k * k) + c * k + l;
                        let chance = Math.random();
                        let rule = (chance > settings.lambda) ? 0 : Math.floor(Math.random() * (k - 1)) + 1;
                        transitionTable[index] = rule;
                        transitionTable[mirrorIndex] = rule;
                    }
                }
            }
        }

        if (settings.weakQuiescence || settings.strongQuiescence) {
            transitionTable[0] = 0;
        }

        if (settings.strongQuiescence) {
            for (let s = 1; s < k; s++) {
                let solidIndex = s * (k * k) + s * k + s;
                transitionTable[solidIndex] = s;
            }
        }
    }
    updateTransitionTable();

    const gui = new GUI();
    gui.add(settings, 'k', 2, MAX_K, 1).name('States (k)').onChange((v) => {
        palette = generatePalette(v);
        stepUniform[1] = v;
        updateTransitionTable();
        reset();
    });
    gui.add(settings, 'lambda', 0, 1).name('Lambda').onChange(() => { updateTransitionTable(); reset(); });

    let weakController = gui.add(settings, 'weakQuiescence').name('Weak Quiescence').onChange((v) => {
        if (!v && settings.strongQuiescence) {
            settings.strongQuiescence = false;
            strongController.updateDisplay();
        }
        updateTransitionTable();
        reset();
    });

    let strongController = gui.add(settings, 'strongQuiescence').name('Strong Quiescence').onChange((v) => {
        if (v && !settings.weakQuiescence) {
            settings.weakQuiescence = true;
            weakController.updateDisplay();
        }
        updateTransitionTable();
        reset();
    });

    gui.add(settings, 'isotropy').name('Isotropy').onChange(() => { updateTransitionTable(); reset(); });
    gui.add(settings, 'reset').name('Reset');



    function hslToRgbWebGPU(h, s, l) {
        var r, g, b;
        if (s == 0) {
            r = g = b = l;
        } else {
            function hue2rgb(p, q, t) {
                if (t < 0) t += 1;
                if (t > 1) t -= 1;
                if (t < 1 / 6) return p + (q - p) * 6 * t;
                if (t < 1 / 2) return q;
                if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            }
            var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            var p = 2 * l - q;
            r = hue2rgb(p, q, h + 1 / 3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1 / 3);
        }
        // Return plain floats!
        return [r, g, b];
    }

    // 2. The dynamic palette generator
    function generatePalette(k) {
        const paletteData = new Float32Array(k * 4);

        // State 0: Black
        paletteData[0] = 0.0; paletteData[1] = 0.0; paletteData[2] = 0.0; paletteData[3] = 1.0;

        for (let i = 1; i < k; i++) {
            // Calculate hue as a fraction from 0.0 to 1.0 to match your function
            const hueFraction = i / k;

            // Get the RGB floats (Saturation 1.0, Lightness 0.5)
            const [r, g, b] = hslToRgbWebGPU(hueFraction, 1.0, 0.5);

            const offset = i * 4;
            paletteData[offset + 0] = r;
            paletteData[offset + 1] = g;
            paletteData[offset + 2] = b;
            paletteData[offset + 3] = 1.0; // Alpha
        }

        return paletteData;
    }

    const canvas = document.querySelector('canvas');
    const context = canvas.getContext('webgpu');
    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
        device,
        format: presentationFormat
    });

    let palette = generatePalette(settings.k);
    const paletteBuffer = device.createBuffer({
        size: MAX_K * 4 * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })

    const transitionTableBuffer = device.createBuffer({
        size: Math.pow(MAX_K, 3) * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })

    const cellBuffer = device.createBuffer({
        label: 'cell buffer',
        size: uniforms.rez ** 2 * 4,
        usage: GPUBufferUsage.STORAGE,
    })


    const stepUniformBuffer = device.createBuffer({
        label: 'step uniform buffer',
        size: 12,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    const stepUniform = new Uint32Array([0, settings.k, 0]);

    const resetModule = device.createShaderModule({
        label: 'reset shader',
        code: /* wgsl */ `

        @group(0) @binding(0) var<storage, read_write> cells: array<u32>;
        @group(0) @binding(1) var<uniform> sim_uniforms: vec3<u32>;

        fn rand_int(n: f32, seed: f32, max_value: u32) -> u32 {
            let x = sin(n + seed) * 43758.5453;
            let rand_float = fract(x);

            return u32(floor(rand_float * f32(max_value)));
        
        }
        @compute @workgroup_size(16)
        fn reset(@builtin(global_invocation_id) id: vec3u){
            let index = id.x;
            let seed = f32(sim_uniforms.z);
            let random_state = rand_int(f32(id.x), seed, sim_uniforms.y);
            cells[index] = random_state;
        }`
    })

    const simulateModule = device.createShaderModule({
        label: 'simulate shader',
        code: /* wgsl */ `
        @group(0) @binding(0) var<storage, read_write> cells: array<u32>;
        @group(0) @binding(1) var<uniform> sim_uniforms: vec3<u32>;
        @group(0) @binding(2) var<storage, read_write> transitionTable: array<u32>;
        
        @compute @workgroup_size(16)
        fn simulate(@builtin(global_invocation_id) id: vec3u){
            if (id.x >= ${uniforms.rez}) { return; }

            let step = sim_uniforms.x;
            let k = sim_uniforms.y;

                // 2. Calculate X coordinates with Toroidal Wrapping 
            let center_x = id.x;
            let left_x = (id.x + ${uniforms.rez} - 1u) % ${uniforms.rez}; 
            let right_x = (id.x + 1u) % ${uniforms.rez};

                // 3. Calculate the row offsets
            let current_row_offset = step * ${uniforms.rez};
            let next_row_offset = (step + 1u) * ${uniforms.rez};

            // 4. Read the past states using safely wrapped indices
            let past_state_self  = cells[current_row_offset + center_x];
            let past_state_left  = cells[current_row_offset + left_x];
            let past_state_right = cells[current_row_offset + right_x];
            
            // 5. Look up the rule
            let past_states = past_state_left * (k * k) + past_state_self * k + past_state_right;
            
            // 6. Write to the safely bounded next row
            cells[next_row_offset + center_x] = transitionTable[past_states];
        }`
    });


    const resetPipeline = device.createComputePipeline({
        layout: "auto",
        compute: { module: resetModule, entryPoint: 'reset' }
    });

    const simulatePipeline = device.createComputePipeline({
        layout: "auto",
        compute: { module: simulateModule, entryPoint: 'simulate' }
    })

    const resetBindGroup = device.createBindGroup({
        label: 'reset Bind Group',
        layout: resetPipeline.getBindGroupLayout(0),
        entries: [{
            binding: 0,
            resource: { buffer: cellBuffer }
        }, {
            binding: 1,
            resource: { buffer: stepUniformBuffer }
        }],
    });

    const simulateBindGroup =
        device.createBindGroup({
            label: 'Simulate Bind Group',
            layout: simulatePipeline.getBindGroupLayout(0),
            entries: [{
                binding: 0,
                resource: { buffer: cellBuffer }
            },
            {
                binding: 1,
                resource: { buffer: stepUniformBuffer }
            },
            {
                binding: 2,
                resource: { buffer: transitionTableBuffer }
            }
            ],
        });



    const module = device.createShaderModule({
        label: 'harcoded quad shader',
        code: /* wgsl */ `
        
        @group(0) @binding(0) var<storage, read_write> cells: array<u32>;
        @group(0) @binding(1) var<storage, read_write> palette: array<vec4f>;

        struct VertexOutput {
            @builtin(position) position: vec4f,
            @location(0) uv: vec2f,
        }
        @vertex fn vs(
            @builtin(vertex_index) vertexIndex : u32
        ) -> VertexOutput {
            let pos = array(
                vec2f(-1.0, -1.0),
                vec2f(1.0, -1.0),
                vec2f(1.0, 1.0),

                vec2f(-1.0, -1.0),
                vec2f(1.0, 1.0),
                vec2f(-1.0, 1.0)
            );

            var output: VertexOutput;
            output.position = vec4f(pos[vertexIndex], 0.0, 1.0);
            output.uv = vec2f(pos[vertexIndex].x * 0.5 + 0.5, pos[vertexIndex].y * -0.5 + 0.5);
            return output;
        }

        @fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
            var cell_state = cells[i32((uv.x * ${uniforms.rez}) + floor(uv.y * ${uniforms.rez}) *  ${uniforms.rez})];
            return palette[cell_state];
        }
        `
    });


    const pipeline = device.createRenderPipeline({
        label: 'quad pipeline',
        layout: 'auto',
        vertex: {
            entryPoint: 'vs',
            module,
        },
        fragment: {
            entryPoint: 'fs',
            module,
            targets: [{ format: presentationFormat }],
        },
    });

    const renderBindGroup =
        device.createBindGroup({
            label: 'render Bind Group',
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: { buffer: cellBuffer }
                },
                {
                    binding: 1,
                    resource: { buffer: paletteBuffer }
                }
            ],
        });

    const renderPassDescriptor = {
        label: 'basic canvas renderPass',
        colorAttachments: [
            {
                clearValue: [0.3, 0.3, 0.3, 1],
                loadOp: 'clear',
                storeOp: 'store',
            }
        ]
    }

    let step = 0;

    const reset = () => {
        step = 0;
        stepUniform[0] = step;
        stepUniform[2] = Math.floor(Math.random() * 10000);
        device.queue.writeBuffer(stepUniformBuffer, 0, stepUniform);

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(resetPipeline);
        pass.setBindGroup(0, resetBindGroup);
        pass.dispatchWorkgroups(Math.ceil(uniforms.rez / 16));
        pass.end();
        device.queue.submit([encoder.finish()]);
    }
    reset();

    const stepsPerFrame = 10;
    const draw = () => {

        for (let i = 0; i < stepsPerFrame; i++) {
            stepUniform[0] = step;
            device.queue.writeBuffer(stepUniformBuffer, 0, stepUniform);
            device.queue.writeBuffer(transitionTableBuffer, 0, transitionTable);
            const computeEncoder = device.createCommandEncoder();
            const pass = computeEncoder.beginComputePass();
            pass.setBindGroup(0, simulateBindGroup);
            pass.setPipeline(simulatePipeline);
            pass.dispatchWorkgroups(Math.ceil(uniforms.rez / 16));
            pass.end();
            device.queue.submit([computeEncoder.finish()]);
            step++;
        }
        const renderEncoder = device.createCommandEncoder();
        renderPassDescriptor.colorAttachments[0].view = context.getCurrentTexture().createView();
        device.queue.writeBuffer(paletteBuffer, 0, palette);
        const renderPass = renderEncoder.beginRenderPass(renderPassDescriptor);
        renderPass.setPipeline(pipeline);
        renderPass.setBindGroup(0, renderBindGroup);
        renderPass.draw(6);
        renderPass.end();
        const commandBuffer = renderEncoder.finish();
        device.queue.submit([commandBuffer]);

        requestAnimationFrame(draw);
    }

    const observer = new ResizeObserver(entries => {
        for (const entry of entries) {
            const canvas = entry.target;
            const width = entry.contentBoxSize[0].inlineSize;
            const height = entry.contentBoxSize[0].blockSize;
            canvas.width = Math.max(1, Math.min(width, device.limits.maxTextureDimension2D));
            canvas.height = Math.max(1, Math.min(height, device.limits.maxTextureDimension2D));
        }
        // re-render
        draw();
    });
    observer.observe(canvas);

}

function fail(msg) {
    alert(msg);
}

main();

