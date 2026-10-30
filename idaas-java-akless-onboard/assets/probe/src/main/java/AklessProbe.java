import com.aliyuncs.*;
import com.aliyuncs.auth.*;
import com.aliyuncs.profile.DefaultProfile;
import com.aliyuncs.http.*;
import com.cloud_idaas.core.factory.IDaaSCredentialProviderFactory;
import com.cloud_idaas.adapter.alibabacloud.pam.IDaaSPamAklessCredentialFactory;
import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;

public class AklessProbe {
 static AlibabaCloudCredentialsProvider bridge(Supplier<BasicSessionCredentials> source) {
  return () -> source.get();
 }
 static boolean request(DefaultAcsClient client,String endpoint) {
  CommonRequest r=new CommonRequest();r.setSysDomain(endpoint);r.setSysVersion("2014-05-26");r.setSysAction("DescribeRegions");
  r.setSysProtocol(endpoint.startsWith("127.0.0.1:")?ProtocolType.HTTP:ProtocolType.HTTPS);
  r.setSysMethod(MethodType.POST);r.setSysConnectTimeout(5000);r.setSysReadTimeout(10000);
  try {client.getCommonResponse(r);return true;}catch(Exception e){return false;}
 }
 static boolean contract()throws Exception {
  AtomicInteger generation=new AtomicInteger();AtomicInteger accepted=new AtomicInteger();AtomicInteger attempts=new AtomicInteger();
  HttpServer server=HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"),0),0);
  server.createContext("/", exchange -> {
   attempts.incrementAndGet();String query=exchange.getRequestURI().getRawQuery();
   java.io.ByteArrayOutputStream body=new java.io.ByteArrayOutputStream();byte[] buffer=new byte[4096];int count;
   while((count=exchange.getRequestBody().read(buffer))!=-1)body.write(buffer,0,count);
   String encoded=(query==null?"":query)+"&"+body.toString("UTF-8");
   java.util.Map<String,String> fields=new java.util.HashMap<>();
   for(String pair:encoded.split("&")){String[] kv=pair.split("=",2);if(kv.length==2)fields.put(kv[0],URLDecoder.decode(kv[1],"UTF-8"));}
   boolean valid=("fixture-id-"+generation.get()).equals(fields.get("AccessKeyId")) && ("fixture-token-"+generation.get()).equals(fields.get("SecurityToken")) && fields.containsKey("Signature");
   if(valid)accepted.incrementAndGet();byte[] bytes=(valid?"{\"RequestId\":\"offline\"}":"{\"Code\":\"InvalidAccessKeyId\",\"Message\":\"stale\"}").getBytes(StandardCharsets.UTF_8);
   exchange.getResponseHeaders().set("Content-Type","application/json");exchange.sendResponseHeaders(valid?200:403,bytes.length);exchange.getResponseBody().write(bytes);exchange.close();
  });
  server.start();String endpoint="127.0.0.1:"+server.getAddress().getPort();
  Supplier<BasicSessionCredentials> source=()->new BasicSessionCredentials("fixture-id-"+generation.get(),"fixture-secret","fixture-token-"+generation.get());
  DefaultAcsClient client=new DefaultAcsClient(DefaultProfile.getProfile("cn-hangzhou"),bridge(source));client.setAutoRetry(false);
  try {
   if(!request(client,endpoint))return false;generation.incrementAndGet();if(!request(client,endpoint))return false;
   BasicSessionCredentials snapshot=source.get();generation.incrementAndGet();
   DefaultAcsClient stale=new DefaultAcsClient(DefaultProfile.getProfile("cn-hangzhou"),bridge(()->snapshot));stale.setAutoRetry(false);
   try {if(request(stale,endpoint))return false;}finally{stale.shutdown();}
   DefaultAcsClient failed=new DefaultAcsClient(DefaultProfile.getProfile("cn-hangzhou"),bridge(()->{throw new IllegalStateException("offline failure");}));
   int before=attempts.get();try {return !request(failed,endpoint) && attempts.get()==before && accepted.get()==2;}finally{failed.shutdown();}
  }finally {client.shutdown();server.stop(0);}
 }
 public static void main(String[] args) {
  String mode=args.length==0?"contract":args[0];boolean ok=false;boolean acquired=false;String stage="configuration";
  try {
   if(mode.equals("contract")){stage="contract";ok=contract();}
   else if(mode.equals("smoke")) {
    stage="core_init";IDaaSCredentialProviderFactory.init();
    stage="credential_acquisition";com.aliyun.credentials.provider.AlibabaCloudCredentialsProvider provider=IDaaSPamAklessCredentialFactory.getAlibabaCloudCredentialsProvider(System.getenv("ALIBABA_CLOUD_ROLE_ARN"));
    com.aliyun.credentials.models.CredentialModel initial=provider.getCredentials();
    if(initial==null || initial.getAccessKeyId()==null || initial.getAccessKeySecret()==null || initial.getSecurityToken()==null)throw new IllegalStateException("incomplete credential");acquired=true;
    DefaultAcsClient client=new DefaultAcsClient(DefaultProfile.getProfile(System.getenv("ALIBABA_CLOUD_REGION_ID")),bridge(()->{
     com.aliyun.credentials.models.CredentialModel c=provider.getCredentials();return new BasicSessionCredentials(c.getAccessKeyId(),c.getAccessKeySecret(),c.getSecurityToken());
    }));
    stage="read_only_call";try{ok=request(client,"ecs.aliyuncs.com");}finally{client.shutdown();}
   }
  }catch(Exception e){ok=false;}
  System.out.println("{\"mode\":\""+mode+"\",\"ok\":"+ok+",\"credential_acquired\":"+acquired+",\"failed_stage\":\""+(ok?"":stage)+"\",\"refresh_expiry_verified\":false}");
  if(!ok)System.exit(1);
 }
}
