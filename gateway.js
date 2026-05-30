import { createClient } from '@supabase/supabase-js';
import { invoiceQueue } from './queue.js';
import 'dotenv/config';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export async function requestPresignedUpload(fileName, clientId, appUserId) {
  const invoiceId = crypto.randomUUID();
  const extension = fileName.split('.').pop();
  const storagePath = `tenant_${clientId}/${invoiceId}.${extension}`;

  const { data, error } = await supabase.storage
    .from('invoices')
    .createSignedUploadUrl(storagePath);

  if (error) throw new Error(`Signed URL failed: ${error.message}`);

  return {
    invoiceId,
    storagePath,
    uploadUrl: data.signedUrl,
    token: data.token,
    appUserId   // pass back for frontend to store
  };
}

export async function registerUploadComplete(invoiceId, clientId, storagePath, appUserId) {
  const insertData = {
    id: invoiceId,
    client_id: clientId,
    storage_path: storagePath,
    status: 'PENDING'
  };
  if (appUserId && appUserId !== 'null' && appUserId !== 'undefined') {
    insertData.app_user_id = appUserId;
  } else {
    console.warn(`No valid appUserId for invoice ${invoiceId}, skipping association`);
  }

  const { error: insertError } = await supabase.from('invoices').insert(insertData);
  if (insertError) throw new Error(`DB insert failed: ${insertError.message}`);

  const job = await invoiceQueue.add(`invoice_process_${invoiceId}`, {
    invoiceId, clientId, storagePath, appUserId: appUserId || null
  }, { attempts: 3, backoff: 5000 });

  return { success: true, jobId: job.id };
}