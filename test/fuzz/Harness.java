// The JVM side of the differential fuzz (docs/architecture.md): Spark's own SqlBaseLexer and SqlBaseParser from the pinned
// spark-sql-api jar, driven as Spark's AbstractParser drives them, with the flags grammar/port.mjs pins. For each input
// (one base64 line on stdin) it prints one line: the tokens, the parse result, and a digest of the parse tree.
// test/fuzz/dump.ts prints the same line from the plugin's generated TypeScript parser; test/fuzz/run.mjs compares.
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import org.antlr.v4.runtime.*;
import org.antlr.v4.runtime.atn.PredictionMode;
import org.antlr.v4.runtime.misc.Interval;
import org.antlr.v4.runtime.misc.ParseCancellationException;
import org.antlr.v4.runtime.tree.ParseTree;
import org.antlr.v4.runtime.tree.TerminalNode;
import org.apache.spark.sql.catalyst.parser.SqlBaseLexer;
import org.apache.spark.sql.catalyst.parser.SqlBaseParser;

public class Harness {
  /** Spark's UpperCaseCharStream: LA() sees Character.toUpperCase; the text keeps the original. */
  static final class Upper implements CharStream {
    private final CodePointCharStream w;
    Upper(CodePointCharStream w) { this.w = w; }
    public void consume() { w.consume(); }
    public int LA(int i) { int la = w.LA(i); return (la == 0 || la == IntStream.EOF) ? la : Character.toUpperCase(la); }
    public int mark() { return w.mark(); }
    public void release(int marker) { w.release(marker); }
    public int index() { return w.index(); }
    public void seek(int index) { w.seek(index); }
    public int size() { return w.size(); }
    public String getSourceName() { return w.getSourceName(); }
    public String getText(Interval interval) { return w.getText(interval); }
  }

  static final class Count extends BaseErrorListener {
    int errors = 0;
    @Override public void syntaxError(Recognizer<?, ?> r, Object s, int line, int col, String msg, RecognitionException e) { errors++; }
  }

  static String b64(String text) { return Base64.getEncoder().encodeToString(text.getBytes(StandardCharsets.UTF_8)); }

  static void preorder(ParseTree node, StringBuilder kinds, List<String> calls) {
    if (node instanceof TerminalNode) return;
    String name = node.getClass().getSimpleName();
    kinds.append(name).append(',');
    if (name.equals("FunctionCallContext") || name.equals("TableFunctionCallContext") || name.equals("LateralViewContext")) {
      ParseTree target = null;
      for (int i = 0; i < node.getChildCount(); i++) {
        String child = node.getChild(i).getClass().getSimpleName();
        if (child.equals("FunctionNameContext") || child.equals("QualifiedNameContext")) { target = node.getChild(i); break; }
      }
      calls.add(name + ":" + (target == null ? "" : b64(target.getText())));
    }
    for (int i = 0; i < node.getChildCount(); i++) preorder(node.getChild(i), kinds, calls);
  }

  public static void main(String[] args) throws Exception {
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    StringBuilder out = new StringBuilder();
    String line;
    while ((line = in.readLine()) != null) {
      String text = new String(Base64.getDecoder().decode(line), StandardCharsets.UTF_8);
      SqlBaseLexer lexer = new SqlBaseLexer(new Upper((CodePointCharStream) CharStreams.fromString(text)));
      lexer.removeErrorListeners();
      Count lexErrors = new Count();
      lexer.addErrorListener(lexErrors);
      CommonTokenStream tokens = new CommonTokenStream(lexer);
      SqlBaseParser parser = new SqlBaseParser(tokens);
      parser.legacy_setops_precedence_enabled = false;
      parser.legacy_exponent_literal_as_decimal_enabled = false;
      parser.SQL_standard_keyword_behavior = true;
      parser.double_quoted_identifiers = false;
      parser.parameter_substitution_enabled = true;
      parser.legacy_identifier_clause_only = false;
      parser.single_character_pipe_operator_enabled = true;
      parser.removeErrorListeners();
      Count errors = new Count();
      parser.addErrorListener(errors);
      ParseTree tree;
      try {
        parser.setErrorHandler(new BailErrorStrategy());
        parser.getInterpreter().setPredictionMode(PredictionMode.SLL);
        tree = parser.singleStatement();
      } catch (ParseCancellationException e) {
        tokens.seek(0);
        parser.reset();
        parser.removeErrorListeners();
        errors = new Count();
        parser.addErrorListener(errors);
        parser.setErrorHandler(new DefaultErrorStrategy());
        parser.getInterpreter().setPredictionMode(PredictionMode.LL);
        tree = parser.singleStatement();
      }
      tokens.fill();
      StringBuilder toks = new StringBuilder();
      for (Token token : tokens.getTokens()) toks.append(token.getType()).append('.').append(token.getChannel()).append(':').append(b64(token.getText() == null ? "" : token.getText())).append(',');
      boolean ok = lexErrors.errors == 0 && errors.errors == 0 && !lexer.has_unclosed_bracketed_comment;
      String kind = "ERROR";
      String digest = "";
      String calls = "";
      if (ok) {
        StringBuilder kinds = new StringBuilder();
        List<String> found = new ArrayList<>();
        preorder(tree, kinds, found);
        kind = tree.getChild(0).getClass().getSimpleName();
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(kinds.toString().getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (byte b : hash) hex.append(String.format("%02x", b));
        digest = hex.toString();
        calls = String.join(" ", found);
      }
      out.append(toks).append('\t').append(kind).append('\t').append(digest).append('\t').append(calls).append('\n');
    }
    System.out.print(out);
  }
}
