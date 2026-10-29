"use strict";

const {isIP}=require('node:net');
function readServiceConfig(env=process.env){
  const text=name=>typeof env[name]==='string'?env[name].trim():'';
  const owners=text('OWNER_IPS').split(/[\s,]+/).filter(Boolean);
  if(owners.some(ip=>!isIP(ip)))throw new Error('OWNER_IPS must contain only comma-separated IP addresses.');
  return {GIPHY_KEY:text('GIPHY_KEY'),YOUTUBE_API_KEY:text('YOUTUBE_API_KEY'),OWNER_IPS:new Set(owners)};
}
module.exports={readServiceConfig};
