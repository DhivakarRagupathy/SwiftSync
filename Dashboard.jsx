import React, { useState, useEffect } from 'react';

export default function AuditorDashboard({ auditorId, clientId }) {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');

  // Fetch real-time usage metrics on mount
  useEffect(() => {
    fetchMetrics();
  }, [auditorId]);

  const fetchMetrics = async () => {
    try {
      setLoading(true);
      const res = await fetch(`http://localhost:3000/api/dashboard/metrics?auditorId=${auditorId}`);
      const data = await res.json();
      if (res.ok) {
        setMetrics(data.summary);
      } else {
        console.error(data.error);
      }
    } catch (err) {
      console.error("Failed to connect to API server:", err);
    } finally {
      setLoading(false);
    }
  };

  // Handle file drop, direct S3 upload, and background queue signaling
  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    try {
      setUploading(true);
      setUploadStatus('Requesting signed URL clearance...');

      // Step 1: Request presigned URL from API Gateway
      const initRes = await fetch('http://localhost:3000/api/upload/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, clientId })
      });
      const initData = await initRes.json();
      if (!initRes.ok) throw new Error(initData.error);

      const { invoiceId, storagePath, uploadUrl, token } = initData;

      setUploadStatus('Streaming file binary directly to cloud storage...');

      // Step 2: Upload file directly to Supabase storage bypass server memory
      const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': file.type
        },
        body: file
      });

      if (!uploadRes.ok) throw new Error('Direct-to-cloud upload sequence failed.');

      setUploadStatus('Registering database entry & spawning worker job...');

      // Step 3: Signal backend completion to enqueue background task
      const completeRes = await fetch('http://localhost:3000/api/upload/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceId, clientId, storagePath })
      });
      const completeData = await completeRes.json();
      if (!completeRes.ok) throw new Error(completeData.error);

      setUploadStatus(`Upload locked. Task successfully queued (Job ID: ${completeData.jobId})`);
      setTimeout(() => setUploadStatus(''), 4000);
      fetchMetrics(); // Refresh numbers immediately

    } catch (err) {
      setUploadStatus(`Error: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  // Trigger browser download for Tally-compatible CSV file
  const handleExportTally = async () => {
    try {
      window.open(`http://localhost:3000/api/export/tally?clientId=${clientId}`, '_blank');
    } catch (err) {
      console.error("Export failure:", err);
    }
  };

  if (loading) return <div className="p-8 text-slate-500 font-medium">Loading ledger infrastructure...</div>;

  return (
    <div className="max-w-6xl mx-auto p-6 bg-slate-50 min-h-screen font-sans">
      {/* Header section */}
      <div className="flex justify-between items-center mb-8 border-b border-slate-200 pb-5">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">SwiftSync Platform Dashboard</h1>
          <p className="text-sm text-slate-500 mt-1">Tenant ID: {clientId}</p>
        </div>
        <button
          onClick={handleExportTally}
          className="bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded font-medium text-sm transition-colors"
        >
          Export Tally Vouchers (.CSV)
        </button>
      </div>

      {/* Metrics Layout Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-5 mb-8">
        <div className="bg-white p-5 rounded border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">Total Invoices</span>
          <span className="text-3xl font-bold text-slate-800 mt-2 block">{metrics?.total_invoices_processed}</span>
        </div>
        <div className="bg-white p-5 rounded border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">Gross Client Billing</span>
          <span className="text-3xl font-bold text-emerald-600 mt-2 block">₹{metrics?.gross_billing_inr}</span>
        </div>
        <div className="bg-white p-5 rounded border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">Partner Commission (₹1/pg)</span>
          <span className="text-3xl font-bold text-blue-600 mt-2 block">₹{metrics?.partner_payout_inr}</span>
        </div>
        <div className="bg-white p-5 rounded border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">Net SaaS Revenue</span>
          <span className="text-3xl font-bold text-slate-900 mt-2 block">₹{metrics?.net_saas_profit_inr}</span>
        </div>
      </div>

      {/* Upload Zone */}
      <div className="bg-white p-6 rounded border border-slate-200 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-800 mb-4">Ingest Document Batch</h2>
        <div className="border-2 border-dashed border-slate-200 rounded-lg p-8 text-center bg-slate-50 hover:bg-slate-100 transition-colors relative">
          <input
            type="file"
            onChange={handleFileUpload}
            disabled={uploading}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            accept="image/jpeg,image/png,application/pdf"
          />
          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-700">
              {uploading ? 'Uploading in progress...' : 'Drag and drop files here, or click to browse'}
            </p>
            <p className="text-xs text-slate-400">Supports JPEG, PNG, and PDF document formats</p>
          </div>
        </div>

        {uploadStatus && (
          <div className="mt-4 p-3 bg-slate-900 text-slate-100 rounded text-xs font-mono">
            {uploadStatus}
          </div>
        )}
      </div>
    </div>
  );
}