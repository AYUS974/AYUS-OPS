const fs=require("fs");
console.log("boot");
setTimeout(()=>{fs.writeFileSync(__dirname+"/../wtest/out.json",Date.now()+"");console.log("wrote")},1000);
setTimeout(()=>process.exit(0),6000);
