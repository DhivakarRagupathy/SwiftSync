import { invoiceQueue } from './queue.js';

async function dispatchMockBatch() {
  console.log("Enqueueing a batch of parallel test extraction requests...");

  const mockTasks = Array.from({ length: 5 }).map((_, i) => ({
    name: `mock_invoice_${i}`,
    data: {
      // Changed the first character to 'f' to match our valid hex DB seed
      invoiceId: "f0000000-0000-0000-0000-000000000000", 
      clientId: "c0000000-0000-0000-0000-000000000000",
      storagePath: "test_samples/invoice_mock_file.jpg"
    },
    opts: { attempts: 3, backoff: 5000 }
  }));

  await invoiceQueue.addBulk(mockTasks);
  console.log("All 5 background jobs successfully stacked inside Redis queue pipeline.");
  process.exit(0);
}

dispatchMockBatch();