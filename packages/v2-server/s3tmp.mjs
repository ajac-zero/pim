import S3rver from "s3rver";
const s = new S3rver({ port: 54330, address: "127.0.0.1", silent: true, directory: "/tmp/s3dir", configureBuckets: [{ name: "pim", configs: [] }] });
await s.run(); console.log("s3 up"); setInterval(()=>{}, 1e9);
