const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');

// --- Configuration ---
const API_URL = 'https://ws.wizground.com/api';
const TOKEN = '3EFE2B45E8407700AB4D20324B7D001B'; // Authorization Header & Signature Key
const STATION = 'fb3a7767-b991-42b8-8eb0-6d635901e01b';
const COMPANY = 'okelbro';
const NET_PASSPORT_ID = '35893';
const TEMPLATE_FILE = './reports/181.txt';

/**
 * Loads the report template and replaces dynamic placeholders.
 * The ENCRYPTED_DATA mock is replaced with a simple placeholder for demonstration
 * as the actual encryption logic is missing. The primary focus here is the signature logic.
 * @param {string} defVal - The default value to insert into the template.
 * @returns {string} The raw, unencrypted template string, ready to be sent (or encrypted).
 */
function loadEncrypted(defVal) {
  // IMPORTANT: For this code to run, you must have the '181.txt' file in the same directory.
  try {
    let template = fs.readFileSync(TEMPLATE_FILE, 'utf8');

    const today = new Date();
    // Formats date as dd/mm/yyyy
    const formattedDate = today.toLocaleDateString('en-GB').split('/').join('/'); 

    // Replace dynamic values in the template
    let finalTemplate = template.replace('{{ID}}', defVal);
    finalTemplate = finalTemplate.replace('{{DATE}}', formattedDate);

    console.log(finalTemplate)
    
    // Replace the encrypted placeholder (assuming actual encryption is done elsewhere or this is the final format)
    // NOTE: If the ENCRYPTED_DATA value must be replaced before signature, 
    // you would need the actual encryption key and algorithm.
    // Assuming the entire JSON block is the content.
    return finalTemplate;

  } catch (error) {
    console.error(`❌ Error reading template file (${TEMPLATE_FILE}):`, error.message);
    // Exit if the file isn't found, as it's critical
    process.exit(1); 
  }
}

/**
 * Creates the MD5 signature required by the API.
 * The signature is derived from the stringified plugin data payload + the TOKEN.
 * @param {string} pluginDataString - The JSON string of the pluginData payload.
 * @returns {string} The MD5 hash signature.
 */
function createSignature(pluginDataString) {
  // Based on your note: "the signature is enctypted report + token"
  // The input string for hashing is the JSON content (the ENCRYPTED_DATA from your original logic) 
  // concatenated directly with the TOKEN string.
  return crypto.createHash('md5').update(pluginDataString + TOKEN).digest('hex');
}

/**
 * Fetches the report from the Wizground API.
 * @param {string} defVal - The default value for the report parameter.
 */
async function getReport(defVal) {
  // Step 1: Prepare the 'ENCRYPTED' data. 
  // We use the entire prepared JSON string here, assuming this is the payload 
  // that needs to be treated as the 'encrypted report data' for both sending and hashing.
  const ENCRYPTED_DATA_STRING = loadEncrypted(defVal);
  
  // Step 2: Calculate the signature.
  // The signature must be calculated on the exact string used in the message payload.
  const signature = createSignature(ENCRYPTED_DATA_STRING);
  console.log(signature)

  // Step 3: Construct the message payload.
  // The API expects the raw encrypted string inside the 'encrypt_reportData' property.
  // NOTE: Your Postman example shows the entire JSON string as the 'encrypt_reportData' value,
  // but based on typical API design, the value should be the actual encrypted string (e.g. 'e47f0faa83806edb5e4dfed6305d42fe:1a3c0...').
  // Since we don't have the encryption logic, we proceed by passing the prepared template string, 
  // but if the server expects a short encrypted string, this line needs adjustment.
  const messageData = {
    netPassportID: NET_PASSPORT_ID,
    pluginData: ENCRYPTED_DATA_STRING 
  };
  // Step 4: Construct the final request payload.
  const finalPayload = {
    station: STATION,
    plugin: "reports",
    company: COMPANY,
    message: messageData,
    signature: signature // The correctly generated signature
  };
  console.log("-> Payload ready. Sending request to API...");

  try {
    const response = await axios.post(API_URL, finalPayload, {
      headers: { 
        'Content-Type': 'application/json' 
      }
    });

    console.log("✅ API Response Status:", response.status);
    console.log("✅ Response Data:", response.data);

// Access the specific object inside the array
const resultObject = response.data.apiRes.data[0];

// Log the object directly
console.log("✅ Content of the API Report Object:", resultObject);
  } catch (error) {
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      console.error("❌ API Error Status:", error.response.status);
      console.error("❌ API Error Data:", error.response.data);
    } else if (error.request) {
      // The request was made but no response was received
      console.error("❌ Network Error: No response received from API.");
    } else {
      // Something happened in setting up the request that triggered an Error
      console.error("❌ Request Setup Error:", error.message);
    }
  }
}

// Execute the function with the provided default value
getReport("38611");