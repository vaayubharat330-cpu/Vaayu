const API_VERSION = '2024-11-30';

class DocumentOcrProvider {
  constructor({ fetchImpl = global.fetch, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    this.fetch = fetchImpl;
    this.wait = wait;
  }

  get endpoint() { return String(process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT || '').replace(/\/$/, ''); }
  get key() { return process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY || ''; }
  get configured() { return Boolean(this.endpoint && this.key); }

  async analyze(bytes, contentType) {
    if (!this.configured) return { configured: false, status: 'NOT_CONFIGURED', provider: null, extractedText: '', fields: {} };
    const endpoint = new URL(this.endpoint);
    if (endpoint.protocol !== 'https:') throw new Error('Azure Document Intelligence endpoint must use HTTPS.');
    const url = `${this.endpoint}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=${API_VERSION}`;
    const response = await this.fetch(url, {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': this.key, 'Content-Type': contentType },
      body: bytes,
      signal: AbortSignal.timeout(15000)
    });
    if (response.status !== 202) throw new Error(`Azure Document Intelligence returned HTTP ${response.status}`);
    const operation = response.headers.get('operation-location');
    if (!operation) throw new Error('Azure OCR response did not include an operation location.');
    const operationUrl = new URL(operation);
    if (operationUrl.protocol !== 'https:' || operationUrl.host !== endpoint.host) throw new Error('Azure OCR returned an unexpected operation host.');
    for (let attempt = 0; attempt < 12; attempt++) {
      await this.wait(Math.min(1000 + attempt * 500, 3000));
      const resultResponse = await this.fetch(operationUrl, {
        headers: { 'Ocp-Apim-Subscription-Key': this.key },
        signal: AbortSignal.timeout(10000)
      });
      if (!resultResponse.ok) throw new Error(`Azure OCR polling returned HTTP ${resultResponse.status}`);
      const result = await resultResponse.json();
      if (result.status === 'succeeded') {
        const analyzeResult = result.analyzeResult || {};
        return {
          configured: true,
          provider: 'AZURE_DOCUMENT_INTELLIGENCE',
          status: 'OCR_COMPLETE_REVIEW_REQUIRED',
          extractedText: String(analyzeResult.content || '').slice(0, 30000),
          fields: analyzeResult.documents?.[0]?.fields || {},
          pageCount: analyzeResult.pages?.length || 0,
          modelId: analyzeResult.modelId || 'prebuilt-read'
        };
      }
      if (result.status === 'failed') throw new Error('Azure Document Intelligence could not read this document.');
    }
    return { configured: true, provider: 'AZURE_DOCUMENT_INTELLIGENCE', status: 'OCR_PENDING', extractedText: '', fields: {} };
  }
}

module.exports = { DocumentOcrProvider, documentOcrProvider: new DocumentOcrProvider() };
