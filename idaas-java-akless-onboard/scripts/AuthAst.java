// Parse with javac only; no annotation processing, type loading or source execution.
import com.sun.source.tree.*;
import com.sun.source.util.*;
import javax.tools.*;
import java.util.*;
import java.io.*;

public class AuthAst {
 static Map<String,Object> obj(Object... pairs) {
  Map<String,Object> m=new LinkedHashMap<>();for(int i=0;i<pairs.length;i+=2)m.put((String)pairs[i],pairs[i+1]);return m;
 }
 static Object expr(Tree t) {
  if(t instanceof IdentifierTree)return obj("kind","ref","name",t.toString());
  if(t instanceof MemberSelectTree){MemberSelectTree x=(MemberSelectTree)t;return obj("kind","member","base",expr(x.getExpression()),"name",x.getIdentifier().toString());}
  if(t instanceof MethodInvocationTree){MethodInvocationTree x=(MethodInvocationTree)t;List<Object>a=new ArrayList<>();for(Tree n:x.getArguments())a.add(expr(n));return obj("kind","call","base",expr(x.getMethodSelect()),"args",a);}
  if(t instanceof NewClassTree){NewClassTree x=(NewClassTree)t;List<Object>a=new ArrayList<>();for(Tree n:x.getArguments())a.add(expr(n));return obj("kind","call","base",obj("kind","ref","name",x.getIdentifier().toString()),"args",a);}
  if(t instanceof LiteralTree)return obj("kind","literal","empty","".equals(((LiteralTree)t).getValue()));
  if(t instanceof ParenthesizedTree)return expr(((ParenthesizedTree)t).getExpression());
  if(t instanceof TypeCastTree)return expr(((TypeCastTree)t).getExpression());
  return obj("kind","unknown");
 }
 static String json(Object o) {
  if(o==null)return "null";
  if(o instanceof String)return "\""+((String)o).replace("\\","\\\\").replace("\"","\\\"").replace("\n","\\n").replace("\r","\\r").replace("\t","\\t")+"\"";
  if(o instanceof Map){List<String> a=new ArrayList<>();((Map<?,?>)o).forEach((k,v)->a.add(json(k)+":"+json(v)));return "{"+String.join(",",a)+"}";}
  if(o instanceof Iterable){List<String>a=new ArrayList<>();for(Object x:(Iterable<?>)o)a.add(json(x));return "["+String.join(",",a)+"]";}
  return o.toString();
 }
 public static void main(String[] args)throws Exception {
  JavaCompiler compiler=ToolProvider.getSystemJavaCompiler();if(compiler==null)System.exit(2);
  BufferedReader input=new BufferedReader(new InputStreamReader(System.in,"UTF-8"));String path;
  while((path=input.readLine())!=null){
   DiagnosticCollector<JavaFileObject> diagnostics=new DiagnosticCollector<>();
   try(StandardJavaFileManager fm=compiler.getStandardFileManager(diagnostics,null,java.nio.charset.StandardCharsets.UTF_8)){
    JavacTask task=(JavacTask)compiler.getTask(new StringWriter(),fm,diagnostics,Arrays.asList("-proc:none"),null,fm.getJavaFileObjects(path));
    for(CompilationUnitTree unit:task.parse()){
     List<Object> events=new ArrayList<>();Map<String,String> imports=new HashMap<>();
     for(ImportTree i:unit.getImports()){String q=i.getQualifiedIdentifier().toString();imports.put(q.substring(q.lastIndexOf('.')+1),q);}
     SourcePositions pos=Trees.instance(task).getSourcePositions();
     new TreeScanner<Void,Void>() {
      String scope="global";int depth=0;
      void emit(String kind,String name,Object value,Tree n){events.add(obj("kind",kind,"name",name,"value",value,"scope",scope,"line",unit.getLineMap().getLineNumber(pos.getStartPosition(unit,n)),"uncertain",depth>0));}
      @Override public Void scan(Tree n,Void p){if(n==null)return null;boolean branch=Arrays.asList(Tree.Kind.IF,Tree.Kind.FOR_LOOP,Tree.Kind.ENHANCED_FOR_LOOP,Tree.Kind.WHILE_LOOP,Tree.Kind.DO_WHILE_LOOP,Tree.Kind.SWITCH,Tree.Kind.TRY,Tree.Kind.LAMBDA_EXPRESSION,Tree.Kind.CONDITIONAL_EXPRESSION).contains(n.getKind());if(branch)depth++;Void r=super.scan(n,p);if(branch)depth--;return r;}
      @Override public Void visitClass(ClassTree n,Void p){String old=scope;scope=old+"/"+n.getSimpleName();super.visitClass(n,p);scope=old;return null;}
      @Override public Void visitMethod(MethodTree n,Void p){String old=scope;scope=old+"/"+n.getName()+":"+unit.getLineMap().getLineNumber(pos.getStartPosition(unit,n));emit("function",n.getName().toString(),obj("params",n.getParameters().size()),n);super.visitMethod(n,p);scope=old;return null;}
      @Override public Void visitVariable(VariableTree n,Void p){emit("def",n.getName().toString(),expr(n.getInitializer()),n);return super.visitVariable(n,p);}
      @Override public Void visitAssignment(AssignmentTree n,Void p){String name=n.getVariable().toString();if(name.startsWith("this."))name=name.substring(5);emit("def",name,expr(n.getExpression()),n);return super.visitAssignment(n,p);}
      @Override public Void visitReturn(ReturnTree n,Void p){emit("return","",expr(n.getExpression()),n);return super.visitReturn(n,p);}
      @Override public Void visitMethodInvocation(MethodInvocationTree n,Void p){emit("call","",expr(n),n);return super.visitMethodInvocation(n,p);}
      @Override public Void visitNewClass(NewClassTree n,Void p){emit("call","",expr(n),n);return super.visitNewClass(n,p);}
     }.scan(unit,null);
     boolean error=diagnostics.getDiagnostics().stream().anyMatch(d->d.getKind()==Diagnostic.Kind.ERROR);
     System.out.println(json(error?obj("file",path,"error","parse_failed"):obj("file",path,"imports",imports,"events",events)));
    }
   }catch(Exception e){System.out.println(json(obj("file",path,"error","parse_failed")));}
  }
 }
}
