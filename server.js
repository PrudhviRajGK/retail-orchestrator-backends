require("dotenv").config();

const express = require("express");
const fs = require("fs");
const cors = require("cors");
const bodyParser = require("body-parser");
const sessions = {};

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Load JSON data
const customers = require("./customers.json");
const products = require("./products.json");
const inventory = require("./inventory.json");
const promotions = require("./promotions.json");
const loyaltyRules = require("./loyalty_rules.json");
const fulfillmentRules = require("./fulfillment_rules.json");

const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function getSession(endUserId, channel) {
  if (!sessions[endUserId]) {
    sessions[endUserId] = { cart: [], lastOrderId: null, channel };
  }
  if (channel) sessions[endUserId].channel = channel;
  return sessions[endUserId];
}

async function classifyIntent(userQuery, customer, session) {
  const systemPrompt = `
You are the Sales Orchestrator for an omnichannel fashion retailer.

Your job: From the user's message and context, decide what they are trying to do.

Possible intents:
- "recommend": they are asking what to buy, styles, outfits, suggestions.
- "check_inventory": they are asking if something is in stock or available at a store.
- "checkout": they are ready to buy / pay / place order / reserve.
- "post_purchase": they ask about order status, returns, exchange, tracking.
- "smalltalk": greetings or chit-chat, no need to call worker agents.

Return ONLY valid JSON in this shape:
{
  "intent": "...",
  "target_skus": [],
  "occasion": null,
  "payment_method": null,
  "fulfillment_mode": null
}
`;

  // FIXED: Changed from responses.create to chat.completions.create
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini", // FIXED: Changed from "gpt-4.1-mini" to valid model
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: `User message: "${userQuery}"
Customer: ${JSON.stringify(customer)}
Session: ${JSON.stringify(session)}`
      }
    ],
    response_format: { type: "json_object" }
  });

  // FIXED: Changed from response.output[0].content[0].text to standard response format
  const jsonText = response.choices[0].message.content;
  return JSON.parse(jsonText);
}

async function runRetailOrchestrator({ user_query, end_user_id, channel }) {
  // 1) Load customer + session
  const customer = customers.find(c => c.id === end_user_id) || customers[0];
  const session = getSession(end_user_id, channel);

  // 2) Ask LLM what the user wants
  const plan = await classifyIntent(user_query, customer, session);
  console.log("Sales Agent Plan:", plan);

  let workerResult = {};
  let updatedCart = session.cart;

  // 3) Route to worker agents based on intent
  if (plan.intent === "recommend") {
    const recs = recommendationAgent(customer, user_query);
    workerResult.recommendations = recs;
  }

  if (plan.intent === "check_inventory") {
    const skuList = plan.target_skus.length
      ? plan.target_skus
      : updatedCart.map(i => i.sku);
    workerResult.inventory = inventoryAgent(
      skuList,
      customer.store_location
    );
  }

  if (plan.intent === "checkout") {
    const cartTotal = updatedCart.reduce(
      (sum, item) => sum + item.price * item.qty,
      0
    );

    const loyalty = loyaltyAgent(customer, cartTotal, null);
    workerResult.loyalty = loyalty;

    const payment = await paymentAgent(openai, {
      customerId: customer.id,
      amount: loyalty.finalAmount,
      method: plan.payment_method || "upi"
    });
    workerResult.payment = payment;

    if (payment.status === "success") {
      const fulfillment = fulfillmentAgent({
        orderId: "ORD-" + Date.now(),
        mode: plan.fulfillment_mode || "reserve_in_store",
        storeLocation: customer.store_location,
        slot: "6pm-8pm"
      });
      workerResult.fulfillment = fulfillment;
      session.lastOrderId = fulfillment.orderId || "ORD-XXXX";
      updatedCart = [];
    }
  }

  if (plan.intent === "post_purchase") {
    workerResult.post_purchase = {
      message:
        "I checked your last order. It's currently out for delivery and should arrive in 2–3 days."
    };
  }

  // persist cart
  session.cart = updatedCart;

  // 4) Ask LLM to turn workerResult into a nice reply
  // FIXED: Changed from responses.create to chat.completions.create
  const finalResponse = await openai.chat.completions.create({
    model: "gpt-4o-mini", // FIXED: Changed from "gpt-4.1-mini" to valid model
    messages: [
      {
        role: "system",
        content: `
You are a friendly retail sales associate.
Given the user message, customer info, and worker agent results, 
write a natural, concise reply. 
Explain any discounts, inventory options, and next steps clearly.`
      },
      {
        role: "user",
        content: `User message: "${user_query}"
Customer: ${JSON.stringify(customer)}
Session: ${JSON.stringify(session)}
Agent plan: ${JSON.stringify(plan)}
Worker results: ${JSON.stringify(workerResult)}`
      }
    ]
  });

  // FIXED: Changed from finalResponse.output[0].content[0].text to standard response format
  const replyText = finalResponse.choices[0].message.content;

  return {
    reply: replyText,
    structured: {
      plan,
      workerResult,
      session
    }
  };
}

/*
 |--------------------------------------------------------------------------
 | CUSTOMER API
 |--------------------------------------------------------------------------
*/

app.get("/api/customers/:id", (req, res) => {
  const id = req.params.id;
  const customer = customers.find(c => c.id === id);

  if (!customer) {
    return res.status(404).json({ error: "Customer not found" });
  }

  res.json(customer);
});

/*
 |--------------------------------------------------------------------------
 | PRODUCTS APIs
 |--------------------------------------------------------------------------
*/

app.get("/api/products", (req, res) => {
  let filtered = products;

  if (req.query.category) {
    filtered = filtered.filter(p => p.category === req.query.category);
  }

  if (req.query.occasion) {
    filtered = filtered.filter(p =>
      p.attributes?.occasion?.includes(req.query.occasion)
    );
  }

  res.json(filtered);
});

app.get("/api/products/:sku", (req, res) => {
  const sku = req.params.sku;
  const product = products.find(p => p.sku === sku);

  if (!product) {
    return res.status(404).json({ error: "Product not found" });
  }

  res.json(product);
});

/*
 |--------------------------------------------------------------------------
 | INVENTORY API
 |--------------------------------------------------------------------------
*/

app.get("/api/inventory/:sku", (req, res) => {
  const sku = req.params.sku;
  const location = req.query.location;

  let stockItems = inventory.filter(inv => inv.sku === sku);

  if (location) {
    stockItems = stockItems.filter(inv => inv.location === location);
  }

  if (stockItems.length === 0) {
    return res.status(404).json({ error: "No inventory found for SKU" });
  }

  const response = stockItems.map(item => {
    return {
      sku: item.sku,
      location: item.location,
      stock: item.stock,
      fulfillmentOptions:
        item.location === "online_warehouse"
          ? ["ship_to_home"]
          : item.stock > 0
          ? ["click_and_collect", "reserve_in_store"]
          : ["ship_to_home"]
    };
  });

  res.json(response);
});

/*
 |--------------------------------------------------------------------------
 | PAYMENT API (mock/stub)
 |--------------------------------------------------------------------------
*/

app.post("/api/payment/authorize", (req, res) => {
  const { customerId, amount, method } = req.body;

  if (!customerId || !amount || !method) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const fail = Math.random() < 0.2;

  if (fail) {
    return res.json({
      status: "declined",
      reason: "Gateway timeout",
      retry_supported: true
    });
  }

  return res.json({
    status: "success",
    transactionId: "TXN-" + Date.now(),
    message: "Payment processed successfully"
  });
});

/*
 |--------------------------------------------------------------------------
 | LOYALTY / PROMOTIONS ENGINE
 |--------------------------------------------------------------------------
*/

app.post("/api/loyalty/apply", (req, res) => {
  const { customerId, cartTotal, couponCode } = req.body;

  const customer = customers.find(c => c.id === customerId);

  if (!customer) {
    return res.status(404).json({ error: "Customer not found" });
  }

  const tierRules = loyaltyRules.tiers[customer.loyalty_tier];

  let discount = (cartTotal * tierRules.max_discount_percent) / 100;

  let couponApplied = promotions.find(p => p.id === couponCode);

  if (couponApplied && couponApplied.flat_discount) {
    discount += couponApplied.flat_discount;
  }

  const finalAmount = cartTotal - discount;
  const pointsEarned =
    cartTotal * loyaltyRules.earn_rate.per_rupee * tierRules.points_multiplier;

  res.json({
    discount,
    finalAmount,
    pointsEarned
  });
});

/*
 |--------------------------------------------------------------------------
 | FULFILLMENT API
 |--------------------------------------------------------------------------
*/

app.post("/api/fulfillment/schedule", (req, res) => {
  const { orderId, mode, storeLocation, slot } = req.body;

  const fail = Math.random() < 0.2;

  if (fail) {
    return res.json({
      status: "failed",
      reason: "Slot unavailable",
      alternate_slots: fulfillmentRules.delivery.slot_windows
    });
  }

  if (mode === "reserve_in_store" || mode === "click_and_collect") {
    return res.json({
      status: "scheduled",
      pickupCode: "PICK-" + Math.floor(100000 + Math.random() * 900000),
      message: `Order reserved at ${storeLocation} for ${slot}`
    });
  }

  if (mode === "delivery" || mode === "home_delivery") {
    return res.json({
      status: "scheduled",
      deliveryEstimate: Date.now() + fulfillmentRules.delivery.default_eta_days * 86400000,
      message: "Delivery scheduled successfully"
    });
  }

  res.json({ error: "Invalid fulfillment mode" });
});

/*
 |--------------------------------------------------------------------------
 | WORKER AGENTS
 |--------------------------------------------------------------------------
*/

function recommendationAgent(customer, userQuery) {
  const lowerQ = userQuery.toLowerCase();
  let filtered = products;

  if (lowerQ.includes("shirt")) {
    filtered = filtered.filter(p => p.category === "shirts");
  } else if (lowerQ.includes("shoes") || lowerQ.includes("sneakers")) {
    filtered = filtered.filter(p => p.category === "footwear");
  }

  return filtered.slice(0, 5);
}

function inventoryAgent(skuList, storeLocation) {
  return skuList.map(sku => {
    const stockEntries = inventory.filter(i => i.sku === sku);
    const online = stockEntries.find(i => i.location === "online_warehouse");
    const inStore = stockEntries.find(i => i.location === storeLocation);

    const options = [];
    if (online && online.stock > 0) options.push("ship_to_home");
    if (inStore && inStore.stock > 0) {
      options.push("click_and_collect", "reserve_in_store");
    }

    return {
      sku,
      storeLocation,
      onlineStock: online?.stock || 0,
      storeStock: inStore?.stock || 0,
      fulfillmentOptions: options
    };
  });
}

function loyaltyAgent(customer, cartTotal, couponCode) {
  const tierRules = loyaltyRules.tiers[customer.loyalty_tier];
  let discount = (cartTotal * tierRules.max_discount_percent) / 100;

  const promo = promotions.find(p => p.id === couponCode);
  if (promo?.flat_discount) discount += promo.flat_discount;

  const finalAmount = cartTotal - discount;
  const pointsEarned =
    cartTotal * loyaltyRules.earn_rate.per_rupee * tierRules.points_multiplier;

  return { discount, finalAmount, pointsEarned };
}

async function paymentAgent(client, { customerId, amount, method }) {
  const fail = Math.random() < 0.2;
  if (fail) {
    return {
      status: "declined",
      reason: "Gateway timeout",
      retry_supported: true
    };
  }
  return {
    status: "success",
    transactionId: "TXN-" + Date.now(),
    message: "Payment processed successfully"
  };
}

function fulfillmentAgent({ orderId, mode, storeLocation, slot }) {
  const fail = Math.random() < 0.2;
  if (fail) {
    return {
      status: "failed",
      reason: "Slot unavailable",
      alternate_slots: fulfillmentRules.delivery.slot_windows
    };
  }

  if (mode === "reserve_in_store" || mode === "click_and_collect") {
    return {
      status: "scheduled",
      orderId, // FIXED: Added orderId to return object
      pickupCode: "PICK-" + Math.floor(100000 + Math.random() * 900000),
      message: `Order reserved at ${storeLocation} for ${slot}`
    };
  }

  return {
    status: "scheduled",
    orderId, // FIXED: Added orderId to return object
    deliveryEstimateDays: fulfillmentRules.delivery.default_eta_days,
    message: "Delivery scheduled successfully"
  };
}

/*
 |--------------------------------------------------------------------------
 | RETAIL ORCHESTRATOR ENDPOINT
 |--------------------------------------------------------------------------
*/

app.post("/api/retail-orchestrator", async (req, res) => {
  try {
    const { user_query, end_user_id, channel } = req.body;

    const result = await runRetailOrchestrator({
      user_query,
      end_user_id,
      channel
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      reply:
        "Sorry, something went wrong while processing your request. Please try again.",
      error: err.message
    });
  }
});

/*
 |--------------------------------------------------------------------------
 | SERVER START
 |--------------------------------------------------------------------------
*/

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});