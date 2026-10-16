'use strict';
const { KycReviewService } = require('../services/kycReviewService');

function createKycReviewRoutes({ db, enforceSecurityChecks, parseJsonBody, websocketService }) {
  const service = new KycReviewService({ db });
  return async function handle(req, res, { pathname, parsedUrl }) {
    if (!pathname.startsWith('/api/admin/kyc/review-cases')) return false;
    if (!await enforceSecurityChecks(req, res, { requiredRoles: ['ADMIN', 'SUPER_ADMIN', 'FLEET_ADMIN'] })) return true;
    const store = db.getDb();
    store.kyc_review_cases ||= [];
    store.kyc_review_decisions ||= [];
    if (pathname === '/api/admin/kyc/review-cases' && req.method === 'GET') {
      const status = String(parsedUrl.query.status || 'OPEN').toUpperCase();
      const cases = store.kyc_review_cases.filter(c => status === 'ALL' || c.status === status).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
      return res.end(JSON.stringify({success:true,count:cases.length,cases}));
    }
    const detail = pathname.match(/^\/api\/admin\/kyc\/review-cases\/([^/]+)$/);
    if (detail && req.method === 'GET') {
      const item = store.kyc_review_cases.find(c => c.id === decodeURIComponent(detail[1]));
      if (!item) { res.writeHead(404, {'Content-Type':'application/json'}); return res.end(JSON.stringify({success:false,error:'KYC_REVIEW_NOT_FOUND'})); }
      const decisions = store.kyc_review_decisions.filter(d => d.caseId === item.id);
      res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
      return res.end(JSON.stringify({success:true,case:{...item,decisions}}));
    }
    const decision = pathname.match(/^\/api\/admin\/kyc\/review-cases\/([^/]+)\/decision$/);
    if (decision && req.method === 'POST') {
      let body=''; req.on('data', c => { body += c; });
      req.on('end', () => {
        const data=parseJsonBody(res,body); if (!data) return;
        try {
          const resolved=service.resolveCase({caseId:decodeURIComponent(decision[1]),reviewerId:req.user.id,decision:String(data.decision||'').toUpperCase(),reason:data.reason,evidenceHash:data.evidenceHash||null});
          const docs=db.getDriverDocuments?db.getDriverDocuments(resolved.driverId):[];
          const doc=docs.find(d=>d.id===resolved.documentId);
          if (doc && db.updateDriverDocument) db.updateDriverDocument(doc.id,{status:resolved.finalDecision,notes:resolved.resolutionReason,verifiedBy:req.user.id});
          const nextDocs=db.getDriverDocuments?db.getDriverDocuments(resolved.driverId):[];
          const rejected=nextDocs.some(d=>['REJECTED','ACTION_REQUIRED'].includes(String(d.status||'').toUpperCase()));
          const verified=nextDocs.length>0 && nextDocs.every(d=>['VERIFIED','APPROVED'].includes(String(d.status||'').toUpperCase()));
          const kycStatus=rejected?'ACTION_REQUIRED':(verified?'APPROVED':'PENDING');
          const driver=db.updateDriverKyc?db.updateDriverKyc(resolved.driverId,kycStatus):null;
          if (db.updateKycStep) db.updateKycStep(resolved.driverId,verified?4:2,kycStatus,driver?.name||'Driver');
          websocketService.broadcastToRoom('admin:control_tower','operator_action',{action:'RESOLVE_KYC_REVIEW',caseId:resolved.id,driverId:resolved.driverId,decision:resolved.finalDecision,operatorId:req.user.id});
          res.writeHead(200, {'Content-Type':'application/json','Cache-Control':'no-store'});
          return res.end(JSON.stringify({success:true,case:resolved,driverKycStatus:kycStatus}));
        } catch(error) {
          const status=error.code==='KYC_REVIEW_NOT_FOUND'?404:error.code==='KYC_REVIEW_ALREADY_RESOLVED'?409:400;
          res.writeHead(status, {'Content-Type':'application/json'});
          return res.end(JSON.stringify({success:false,error:error.code||'KYC_REVIEW_FAILED',message:error.message}));
        }
      });
      return true;
    }
    res.writeHead(405, {'Content-Type':'application/json','Allow':'GET, POST'}); return res.end(JSON.stringify({success:false,error:'Method not allowed'}));
  };
}
module.exports={createKycReviewRoutes};
