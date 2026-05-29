import { createClient } from '@supabase/supabase-js';
import { invoiceQueue } from './queue.js';
import './queue.js';
import 'dotenv/config';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * Endpoint Step 1: Generates a temporary authorization pass for the client browser
 */
export async function requestPresignedUpload(clientFileName, clientId) {
  const invoiceId = crypto.randomUUID(); // Generate structural UUID up front
  const extension = clientFileName.split('.').pop();
  const storagePath = `tenant_${clientId}/${invoiceId}.${extension}`;

  // Generate a signed upload token valid for 15 minutes
  const { data, error } = await supabase.storage
    .from('invoices')
    .createSignedUploadUrl(storagePath);

  if (error) throw new Error(`Signed URL allocation aborted: ${error.message}`);

  return {
    invoiceId,
    storagePath,
    uploadUrl: data.signedUrl,
    token: data.token // Needed by client SDK to validate storage write permissions
  };
}

/**
 * Endpoint Step 2: Fired immediately after the client browser confirms the file hit cloud storage
 */
export async function registerUploadComplete(invoiceId, clientId, storagePath) {
  // 1. Log a real structural pending entry inside our PostgreSQL core
  const { error } = await supabase
    .from('invoices')
    .insert({
      id: invoiceId,
      client_id: clientId,
      storage_path: storagePath,
      status: 'PENDING'
    });

  if (error) throw new Error(`Database registration failure: ${error.message}`);

  // 2. Dispatch the payload down to our BullMQ Redis background worker pool
  const job = await invoiceQueue.add(`invoice_process_${invoiceId}`, {
    invoiceId,
    clientId,
    storagePath
  }, {
    attempts: 3,
    backoff: 5000
  });

  console.log(`[Enqueued] Web request transformed into background job: ${job.id}`);
  return { success: true, jobId: job.id };
}