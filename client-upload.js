import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { requestPresignedUpload, registerUploadComplete } from './gateway.js';


const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function simulateBrowserFlow() {
  const mockClientId = "c0000000-0000-0000-0000-000000000000"; // Reusing our verified seed ID
  const testFileName = "office_bill.jpg";

  console.log("1. Requesting upload token clearance from backend API...");
  const registrationMetaData = await requestPresignedUpload(testFileName, mockClientId);
  
  console.log(`✔ Clearance granted. Destination assigned: ${registrationMetaData.storagePath}`);

  // Construct a dummy dummy binary layout to represent our file payload
  const mockFileBuffer = Buffer.from("faked_image_binary_data_for_structural_testing");

  console.log("2. Streaming binary data directly from machine to Supabase Cloud Bucket...");
  const { error: uploadError } = await supabase.storage
    .from('invoices')
    .uploadToSignedUrl(registrationMetaData.storagePath, registrationMetaData.token, mockFileBuffer, {
      contentType: 'image/jpeg'
    });

  if (uploadError) {
    console.error(`❌ Cloud upload bricked: ${uploadError.message}`);
    return;
  }
  console.log("✔ Binary safely written to encrypted cloud storage bucket.");

  console.log("3. Notifying API to lock database records and fire background job worker queues...");
  const status = await registerUploadComplete(
    registrationMetaData.invoiceId,
    mockClientId,
    registrationMetaData.storagePath
  );

  console.log(`✔ Ingestion cycle absolute success. Tracking Job ID: ${status.jobId}`);
  process.exit(0);
}

simulateBrowserFlow();