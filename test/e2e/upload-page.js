import { createLocalClient } from 'everything-webgpu';
const out = document.querySelector('pre');
window.runUploadBench = async ({ modelId, modelLib }) => {
  const client = createLocalClient({ modelId, model: `${location.origin}/models/resolve/main/`, modelLib: `${location.origin}/models/${modelLib}` });
  const request = { input: 'Reply with exactly: hello', temperature: 0, max_output_tokens: 16 };
  const result = { trials: [], userAgent: navigator.userAgent };
  try {
    const warm = await client.responses.create(request);
    if (!warm.output_text) throw new Error(JSON.stringify(warm.error));
    result.output = warm.output_text;
    for (let i = 0; i < 5; i++) {
      await client.unload();
      const start = performance.now();
      const response = await client.responses.create(request);
      const requestMs = performance.now() - start;
      if (response.output_text !== result.output) throw new Error('Deterministic output changed after cached reload');
      const diagnostics = await client.diagnostics();
      const metrics = diagnostics.state.loadMetrics;
      if (!metrics || metrics.tensors !== 435) throw new Error('Missing upload telemetry or unexpected model');
      result.trials.push({ requestMs, ...metrics });
      const text = `Cached trial ${i + 1}: ${requestMs.toFixed(1)} ms, ${metrics.barriers} barriers, sync ${metrics.syncMs.toFixed(1)} ms`;
      out.textContent += text + '\n'; console.log('[debug] ' + text);
    }
    const median = (key) => result.trials.map((x) => x[key]).sort((a, b) => a - b)[2];
    result.medians = Object.fromEntries(['requestMs', 'totalMs', 'cacheReadMs', 'decodeMs', 'submitMs', 'syncMs', 'shaderMs'].map((key) => [key, median(key)]));
    return result;
  } finally { await client.dispose(); }
};
