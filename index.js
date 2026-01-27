const express = require("express");

const app = express();
app.use(express.json());

/* ---------------- HELPERS ---------------- */

function assertEnv() {
  if (!process.env.SUMMIT_COMPANY_ID || !process.env.SUMMIT_API_KEY) {
    throw new Error("Missing Summit credentials in env variables");
  }
}

function getCustomerExternalIdentifier(saved) {
  if (!saved || !saved.customerexternalidentifier) {
    throw new Error("customerexternalidentifier is required");
  }
  return String(saved.customerexternalidentifier);
}

function getPersonId(saved) {
  if (!saved || !saved.personid) {
    throw new Error("personid is required");
  }
  return String(saved.personid);
}

/* ---------------- SUMMIT RESPONSE HANDLER ---------------- */

function unwrapSummit(response) {
  if (!response || response.Status === undefined) {
    throw new Error("Invalid response from Summit");
  }

  if (response.Status !== 0) {
    throw new Error(
      response.UserErrorMessage ||
      response.TechnicalErrorDetails ||
      "Summit returned an error"
    );
  }

  return response.Data || {};
}

/* ---------------- SUMMIT: DOCUMENT ---------------- */

async function createInvoiceAndReceipt({
  saved,
  amount,
  last4,
  payments,
  sku,
  hospital,
  datecare
}) {
  assertEnv();

  if (!sku) throw new Error("SKU Item is required");
  if (!amount) throw new Error("amount is required for payment");

  /* ---------- CARE DATE ---------- */

  let careDate;

  if (datecare) {
    // expected format: YYYY-MM-DD
    careDate = new Date(datecare);
  } else {
    careDate = new Date();
  }

  if (isNaN(careDate.getTime())) {
    throw new Error("Invalid datecare value");
  }

  const formattedDate = careDate.toLocaleDateString("he-IL");
  const itemDescription = `השגחה בטיפול פוריות ${formattedDate} ${hospital}`;

  const customerExternalId = getCustomerExternalIdentifier(saved);
  const personId = getPersonId(saved);

  const customerNameNormalized =
    saved.CustomerName && saved.CustomerName.trim() !== ""
      ? saved.CustomerName.trim()
      : null;

  /* ---------- CREDIT CARD DETAILS ---------- */

  const creditCardDetails = {
    Last4Digits: last4 ? String(last4) : null,
    Payments: payments
  };

  if (payments === 1) {
    creditCardDetails.FirstPayment = amount;
  } else {
    creditCardDetails.FirstPayment = amount / payments;
    creditCardDetails.EachPayment = amount / payments;
  }

  /* ---------- PAYLOAD ---------- */

  const payload = {
    Details: {
      Type: 1,
      Date: careDate.toISOString(),
      Original: true,
      IsDraft: false,
      Customer: {
        ExternalIdentifier: customerExternalId,
        CompanyNumber: personId,
        Name: customerNameNormalized || "Client",
        Phone: saved.CustomerPhone || null,
        EmailAddress: saved.CustomerEmail || null,
        SearchMode: 2
      }
    },

    Items: [
      {
        Quantity: 1,
        UnitPrice: amount,
        TotalPrice: amount,
        Description: itemDescription,
        Item: {
          ExternalIdentifier: String(sku),
          SearchMode: 2
        }
      }
    ],

    Payments: [
      {
        Amount: amount,
        Type: 5,
        Details_CreditCard: creditCardDetails
      }
    ],

    VATIncluded: true,

    Credentials: {
      CompanyID: Number(process.env.SUMMIT_COMPANY_ID),
      APIKey: process.env.SUMMIT_API_KEY
    }
  };

  const res = await fetch(
    "https://app.sumit.co.il/accounting/documents/create/",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  const summit = unwrapSummit(await res.json());

  if (!summit.DocumentID) {
    throw new Error("Failed to create document");
  }

  return summit;
}

/* ---------------- API ENTRY (POST) ---------------- */

app.post("/summit", async (req, res) => {
  try {
    const {
      saved,
      amount,
      last4,
      payments = 1,
      sku,
      hospital,
      datecare
    } = req.body;

    const document = await createInvoiceAndReceipt({
      saved,
      amount,
      last4,
      payments,
      sku,
      hospital,
      datecare
    });

    res.json({
      ok: true,
      documentId: document.DocumentID,
      receiptUrl: document.DocumentDownloadURL
    });

  } catch (err) {
    console.error("Summit error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ---------------- SALESFORCE BUTTON (GET + REDIRECT) ---------------- */

app.get("/summit-from-sf", async (req, res) => {
  try {
    const {
      paymentId,
      familyid,
      personid,
      customername,
      customerphone,
      customeremail,
      amount,
      hospital,
      sku,
      last4,
      payments,
      datecare
    } = req.query;

    if (!paymentId) throw new Error("paymentId is required");
    if (!familyid) throw new Error("familyid is required");
    if (!personid) throw new Error("personid is required");
    if (!amount) throw new Error("amount is required");
    if (!hospital) throw new Error("hospital is required");
    if (!sku) throw new Error("sku is required");

    const saved = {
      customerexternalidentifier: familyid,
      personid: personid,
      CustomerName: customername,
      CustomerPhone: customerphone || null,
      CustomerEmail: customeremail || null
    };

    const document = await createInvoiceAndReceipt({
      saved,
      amount: Number(amount),
      last4: last4 || null,
      payments: payments ? Number(payments) : 1,
      sku,
      hospital,
      datecare
    });

    res.redirect(
      `https://puah.lightning.force.com/flow/SaveReceipt` +
      `?recordId=${paymentId}` +
      `&receiptUrl=${encodeURIComponent(document.DocumentDownloadURL)}`
    );

  } catch (err) {
    console.error("SF GET Summit error:", err.message);
    res.status(500).send(err.message);
  }
});

/* ---------------- SERVER ---------------- */

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
