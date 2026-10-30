// Parse only: never load packages, execute target code, or print literal values.
package main

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strconv"
	"strings"
)

type E map[string]interface{}

func expr(n ast.Expr) E {
	switch x := n.(type) {
	case *ast.Ident:
		return E{"kind": "ref", "name": x.Name}
	case *ast.SelectorExpr:
		return E{"kind": "member", "base": expr(x.X), "name": x.Sel.Name}
	case *ast.CallExpr:
		args := []E{}
		for _, a := range x.Args {
			args = append(args, expr(a))
		}
		return E{"kind": "call", "base": expr(x.Fun), "args": args}
	case *ast.BasicLit:
		return E{"kind": "literal", "empty": x.Value == `""` || x.Value == "``"}
	case *ast.ParenExpr:
		return expr(x.X)
	case *ast.UnaryExpr:
		return expr(x.X)
	case *ast.CompositeLit:
		fields := map[string]E{}
		for _, a := range x.Elts {
			if kv, ok := a.(*ast.KeyValueExpr); ok {
				if k, ok := kv.Key.(*ast.Ident); ok {
					fields[k.Name] = expr(kv.Value)
				}
			}
		}
		return E{"kind": "object", "fields": fields}
	}
	return E{"kind": "unknown"}
}

type visitor struct {
	fs        *token.FileSet
	events    *[]E
	scope     string
	uncertain bool
}

func (v visitor) Visit(n ast.Node) ast.Visitor {
	if n == nil {
		return nil
	}
	switch p := n.(type) {
	case *ast.FuncDecl:
		v.scope = p.Name.Name + ":" + strconv.Itoa(v.fs.Position(p.Pos()).Line)
	case *ast.IfStmt, *ast.ForStmt, *ast.RangeStmt, *ast.SwitchStmt, *ast.TypeSwitchStmt, *ast.FuncLit:
		v.uncertain = true
	}
	emit := func(kind, name string, value E) {
		*v.events = append(*v.events, E{"kind": kind, "name": name, "value": value, "scope": v.scope, "line": v.fs.Position(n.Pos()).Line, "uncertain": v.uncertain})
	}
	switch x := n.(type) {
	case *ast.AssignStmt:
		for i, l := range x.Lhs {
			name := ""
			if id, ok := l.(*ast.Ident); ok {
				name = id.Name
			}
			if sel, ok := l.(*ast.SelectorExpr); ok {
				name = sel.Sel.Name
			}
			if name != "" && i < len(x.Rhs) {
				emit("def", name, expr(x.Rhs[i]))
			}
		}
	case *ast.ValueSpec:
		for i, id := range x.Names {
			if i < len(x.Values) {
				emit("def", id.Name, expr(x.Values[i]))
			}
		}
	case *ast.ReturnStmt:
		if len(x.Results) > 0 {
			emit("return", "", expr(x.Results[0]))
		}
	case *ast.CallExpr:
		emit("call", "", expr(x))
	case *ast.FuncDecl:
		count := 0
		if x.Type.Params != nil {
			count = len(x.Type.Params.List)
			for _, parameter := range x.Type.Params.List {
				for _, name := range parameter.Names {
					emit("def", name.Name, E{"kind": "unknown"})
				}
			}
		}
		emit("function", x.Name.Name, E{"params": count})
	}
	return v
}

func main() {
	var paths []string
	if json.NewDecoder(os.Stdin).Decode(&paths) != nil {
		os.Exit(2)
	}
	enc := json.NewEncoder(os.Stdout)
	for _, path := range paths {
		fs := token.NewFileSet()
		f, err := parser.ParseFile(fs, path, nil, 0)
		if err != nil {
			enc.Encode(E{"file": path, "error": "parse_failed"})
			continue
		}
		imports := map[string]string{}
		for _, i := range f.Imports {
			p, _ := strconv.Unquote(i.Path.Value)
			name := p[strings.LastIndex(p, "/")+1:]
			if strings.Contains(p, "aliyun-log-go-sdk") {
				name = "sls"
			}
			if i.Name != nil {
				name = i.Name.Name
			}
			imports[name] = p
		}
		events := []E{}
		ast.Walk(visitor{fs: fs, events: &events, scope: "global"}, f)
		enc.Encode(E{"file": path, "imports": imports, "events": events})
	}
}
