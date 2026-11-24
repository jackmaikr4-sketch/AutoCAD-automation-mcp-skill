using System.Text.Json;
using Autodesk.AutoCAD.Runtime;
using Autodesk.AutoCAD.DatabaseServices;
using Autodesk.AutoCAD.Geometry;
using Autodesk.AutoCAD.EditorInput;
using Autodesk.AutoCAD.BoundaryRepresentation;
using App = Autodesk.AutoCAD.ApplicationServices.Core.Application;
using AcException = Autodesk.AutoCAD.Runtime.Exception;
using Exception = System.Exception;

[assembly: CommandClass(typeof(AiCad.Commands))]
namespace AiCad;
public class Commands
{
    static string Root = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(typeof(Commands).Assembly.Location), ".."));
    static JsonSerializerOptions options = new() { WriteIndented = true };
    static double N(JsonElement a, string n, double d = 0) => a.TryGetProperty(n, out var v) ? v.GetDouble() : d;
    static string S(JsonElement a, string n, string d = "") => a.TryGetProperty(n, out var v) ? v.GetString() : d;
    static bool B(JsonElement a, string n, bool d = false) => a.TryGetProperty(n, out var v) ? v.GetBoolean() : d;
    static double[] A(JsonElement a, string n, double[] d = null) => a.TryGetProperty(n, out var v) ? v.EnumerateArray().Select(x => x.GetDouble()).ToArray() : d ?? new double[] { 0, 0, 0 };
    static Point3d P(JsonElement a, string n) => Point(A(a, n));
    static Point3d Point(double[] x) => new(x[0], x[1], x.Length > 2 ? x[2] : 0);
    static Vector3d V(JsonElement a, string n, Vector3d? d = null) => a.TryGetProperty(n, out var v) ? Point(v.EnumerateArray().Select(x => x.GetDouble()).ToArray()) - Point3d.Origin : d ?? Vector3d.ZAxis;
    static double[] XYZ(Point3d p) => new[] { p.X, p.Y, p.Z };
    static string[] H(JsonElement a) => a.TryGetProperty("handles", out var v) ? v.EnumerateArray().Select(x => x.GetString()).ToArray() : new[] { S(a, "handle") };
    static Entity E(Transaction t, Database db, string h, OpenMode mode = OpenMode.ForRead) => t.GetObject(db.GetObjectId(false, new Handle(Convert.ToInt64(h, 16)), 0), mode) as Entity ?? throw new Exception("Not an entity: " + h);
    static double Positive(double x)
    {
        if (!double.IsFinite(x) || x <= 0)
            throw new Exception("Dimension must be finite and positive");
        return x;
    }
    static object Info(Entity e)
    {
        var o = new Dictionary<string, object> { { "handle", e.Handle.ToString() }, { "type", e.GetType().Name }, { "layer", e.Layer }, { "color", e.ColorIndex } };
        try
        {
            var b = e.GeometricExtents;
            o["min"] = XYZ(b.MinPoint);
            o["max"] = XYZ(b.MaxPoint);
            o["size"] = XYZ(Point3d.Origin + (b.MaxPoint - b.MinPoint));
        }
        catch { }
        if (e is Solid3d s)
        {
            o["volume"] = s.MassProperties.Volume;
            o["centroid"] = XYZ(s.MassProperties.Centroid);
            o["valid"] = !s.IsNull && s.MassProperties.Volume > 0;
        }
        if (e is Curve c)
        {
            o["closed"] = c.Closed;
            try
            {
                o["length"] = c.GetDistanceAtParameter(c.EndParam) - c.GetDistanceAtParameter(c.StartParam);
            }
            catch { }
            o["start"] = XYZ(c.StartPoint);
            o["end"] = XYZ(c.EndPoint);
        }
        if (e is Circle ci)
        {
            o["radius"] = ci.Radius;
            o["center"] = XYZ(ci.Center);
            o["normal"] = new[] { ci.Normal.X, ci.Normal.Y, ci.Normal.Z };
        }
        if (e is Polyline pl)
        {
            o["vertices"] = Enumerable.Range(0, pl.NumberOfVertices).Select(i => XYZ(pl.GetPoint3dAt(i))).ToArray();
            o["bulges"] = Enumerable.Range(0, pl.NumberOfVertices).Select(pl.GetBulgeAt).ToArray();
        }
        if (e is DBText txt)
            o["text"] = txt.TextString;
        if (e is Dimension dim)
            o["measurement"] = dim.Measurement;
        return o;
    }
    [CommandMethod("AICADREQUEST5", CommandFlags.Modal)]
    public void Request()
    {
        var doc = App.DocumentManager.MdiActiveDocument;
        var ed = doc.Editor;
        var prompt = ed.GetString(new PromptStringOptions("\nRequest file: ") { AllowSpaces = true });
        if (prompt.Status != PromptStatus.OK)
            return;
        string file = Path.GetFullPath(prompt.StringResult.Trim('"'));
        string ipc = Path.Combine(Root, "artifacts", "ipc") + Path.DirectorySeparatorChar;
        if (!file.StartsWith(ipc, StringComparison.OrdinalIgnoreCase))
            throw new Exception("Request outside IPC directory");
        var q = JsonDocument.Parse(File.ReadAllText(file)).RootElement;
        string id = S(q, "id"), op = S(q, "op");
        object result;
        try
        {
            if (S(q, "document") != doc.Name)
                throw new Exception("Active document changed; refresh document identity");
            using (var l = doc.LockDocument())
            {
                result = Execute(op, q.GetProperty("args"), doc.Database, ed);
            }
            Write(file, new
            {
                id,
                ok = true,
                operation = op,
                result
            });
        }
        catch (Exception ex) { Write(file, new { id, ok = false, operation = op, error = ex.ToString(), errorType = ex.GetType().Name }); }
    }
    static void Write(string file, object value)
    {
        File.WriteAllText(file + ".tmp", JsonSerializer.Serialize(value, options));
        File.Move(file + ".tmp", file + ".result", true);
    }
    static object Execute(string op, JsonElement a, Database db, Editor ed)
    {
        if (op == "api_info")
            return new
            {
                version = typeof(Solid3d).Assembly.GetName().Version.ToString(),
                methods = typeof(Solid3d).GetMethods().Where(m => new[] { "Slice", "CreateSweptSolid", "CreateRevolvedSolid", "CreateLoftedSolid", "CreateExtrudedSolid", "CreateFrustum", "ShellBody", "ChamferEdges", "FilletEdges" }.Contains(m.Name)).Select(m => m.ToString()).ToArray()
            };
        if (op == "regenerate_drawing")
        {
            ed.Regen();
            return new
            {
                regenerated = true
            };
        }
        if (op == "set_view")
        {
            using var view = ed.GetCurrentView();
            double aspect = view.Width / view.Height;
            string name = S(a, "view", "isometric");
            view.ViewDirection = name switch
            {
                "top" => Vector3d.ZAxis,
                "front" => -Vector3d.YAxis,
                "side" => Vector3d.XAxis,
                _ => new Vector3d(1, -1, 1)
            };
            view.Target = Point3d.Origin;
            view.ViewTwist = 0;
            var center = P(a, "target").TransformBy(Matrix3d.PlaneToWorld(view.ViewDirection).Inverse());
            view.CenterPoint = new Point2d(center.X, center.Y);
            view.Height = Positive(N(a, "height", 180));
            view.Width = view.Height * aspect;
            using (var vt = db.TransactionManager.StartTransaction())
            {
                var styles = (DBDictionary)vt.GetObject(db.VisualStyleDictionaryId, OpenMode.ForRead);
                string style = name == "isometric" ? "Conceptual" : "2dWireframe";
                if (styles.Contains(style))
                    view.VisualStyleId = styles.GetAt(style);
                vt.Commit();
            }
            ed.SetCurrentView(view);
            ed.Regen();
            return new
            {
                view = name
            };
        }
        if (op == "checkpoint")
        {
            using var copy = db.Wblock();
            copy.SaveAs(S(a, "path"), DwgVersion.Current);
            return new
            {
                path = S(a, "path"),
                bytes = new FileInfo(S(a, "path")).Length
            };
        }
        if (op == "export_dxf")
        {
            db.DxfOut(S(a, "path"), 16, DwgVersion.Current);
            return new
            {
                path = S(a, "path"),
                bytes = new FileInfo(S(a, "path")).Length
            };
        }
        using var tr = db.TransactionManager.StartTransaction();
        var ms = (BlockTableRecord)tr.GetObject(SymbolUtilityServices.GetBlockModelSpaceId(db), OpenMode.ForWrite);
        string Add(Entity ent)
        {
            ent.SetDatabaseDefaults(db);
            if (S(a, "layer") != "")
                ent.Layer = S(a, "layer");
            ms.AppendEntity(ent);
            tr.AddNewlyCreatedDBObject(ent, true);
            return ent.Handle.ToString();
        }
        var added = new List<string>();
        object answer = null;
        switch (op)
        {
            case "draw_line":
                added.Add(Add(new Line(P(a, "start"), P(a, "end"))));
                break;
            case "draw_circle":
                added.Add(Add(new Circle(P(a, "center"), V(a, "normal"), Positive(N(a, "radius")))));
                break;
            case "draw_arc":
                added.Add(Add(new Arc(P(a, "center"), V(a, "normal"), Positive(N(a, "radius")), N(a, "start_angle") * Math.PI / 180, N(a, "end_angle") * Math.PI / 180)));
                break;
            case "draw_rectangle":
            case "draw_polygon":
            case "draw_polyline":
                {
                    var poly = new Polyline();
                    var pts = new List<Point2d>();
                    if (op == "draw_rectangle")
                    {
                        var p = P(a, "origin");
                        var w = Positive(N(a, "width"));
                        var h = Positive(N(a, "height"));
                        pts.AddRange(new[] { new Point2d(p.X, p.Y), new(p.X + w, p.Y), new(p.X + w, p.Y + h), new(p.X, p.Y + h) });
                        poly.Elevation = p.Z;
                    }
                    else if (op == "draw_polygon")
                    {
                        var p = P(a, "center");
                        int count = (int)N(a, "sides", 6);
                        if (count < 3 || count > 1000)
                            throw new Exception("Invalid side count");
                        double r = Positive(N(a, "radius"));
                        for (int i = 0; i < count; i++)
                        {
                            double ang = (N(a, "rotation") + 360.0 * i / count) * Math.PI / 180;
                            pts.Add(new Point2d(p.X + r * Math.Cos(ang), p.Y + r * Math.Sin(ang)));
                        }
                        poly.Elevation = p.Z;
                    }
                    else
                    {
                        foreach (var v in a.GetProperty("points").EnumerateArray())
                        {
                            var p = Point(v.EnumerateArray().Select(x => x.GetDouble()).ToArray());
                            if (pts.Count == 0)
                                poly.Elevation = p.Z;
                            else if (Math.Abs(poly.Elevation - p.Z) > 1e-8)
                                throw new Exception("2D polyline points must share Z");
                            pts.Add(new(p.X, p.Y));
                        }
                    }
                    for (int i = 0; i < pts.Count; i++)
                        poly.AddVertexAt(i, pts[i], 0, 0, 0);
                    poly.Closed = op != "draw_polyline" || B(a, "closed");
                    added.Add(Add(poly));
                    break;
                }
            case "draw_ellipse":
                added.Add(Add(new Ellipse(P(a, "center"), V(a, "normal"), V(a, "major_axis", Vector3d.XAxis), N(a, "ratio", 0.5), 0, 2 * Math.PI)));
                break;
            case "draw_spline":
                {
                    var pts = new Point3dCollection(a.GetProperty("points").EnumerateArray().Select(v => Point(v.EnumerateArray().Select(x => x.GetDouble()).ToArray())).ToArray());
                    added.Add(Add(new Spline(pts, 3, 1e-6)));
                    break;
                }
            case "draw_hatch":
                {
                    var hatch = new Hatch();
                    added.Add(Add(hatch));
                    hatch.SetHatchPattern(HatchPatternType.PreDefined, S(a, "pattern", "SOLID"));
                    hatch.Associative = true;
                    hatch.AppendLoop(HatchLoopTypes.Outermost, new ObjectIdCollection(H(a).Select(h => E(tr, db, h).ObjectId).ToArray()));
                    hatch.EvaluateHatch(true);
                    break;
                }
            case "create_3d_box":
            case "create_3d_cylinder":
            case "create_3d_sphere":
            case "create_3d_cone":
            case "create_3d_wedge":
            case "create_3d_torus":
                {
                    var s = new Solid3d();
                    double x = N(a, "length"), y = N(a, "width"), z = N(a, "height"), r = N(a, "radius");
                    switch (op)
                    {
                        case "create_3d_box":
                            s.CreateBox(Positive(x), Positive(y), Positive(z));
                            break;
                        case "create_3d_wedge":
                            s.CreateWedge(Positive(x), Positive(y), Positive(z));
                            break;
                        case "create_3d_cylinder":
                            s.CreateFrustum(Positive(z), Positive(r), r, r);
                            break;
                        case "create_3d_cone":
                            s.CreateFrustum(Positive(z), Positive(r), r, N(a, "top_radius"));
                            break;
                        case "create_3d_sphere":
                            s.CreateSphere(Positive(r));
                            break;
                        default:
                            s.CreateTorus(Positive(N(a, "major_radius")), Positive(N(a, "minor_radius")));
                            break;
                    }
                    // API primitives are centred at origin. Box/wedge use requested minimum corner; cylinder/cone use base centre.
                    var at = P(a, "origin");
                    if (op is "create_3d_box" or "create_3d_wedge")
                        at += new Vector3d(x / 2, y / 2, z / 2);
                    else if (op is "create_3d_cylinder" or "create_3d_cone")
                        at += new Vector3d(0, 0, z / 2);
                    s.TransformBy(Matrix3d.Displacement(at - Point3d.Origin));
                    added.Add(Add(s));
                    break;
                }
            case "union_3d":
            case "subtract_3d":
            case "intersect_3d":
                {
                    var hs = H(a);
                    if (hs.Length < 2)
                        throw new Exception("At least two solids required");
                    var first = (Solid3d)E(tr, db, hs[0], OpenMode.ForWrite);
                    foreach (var h in hs.Skip(1))
                    {
                        var other = (Solid3d)E(tr, db, h, OpenMode.ForWrite);
                        using var copy = (Solid3d)other.Clone();
                        first.BooleanOperation(op == "union_3d" ? BooleanOperationType.BoolUnite : op == "subtract_3d" ? BooleanOperationType.BoolSubtract : BooleanOperationType.BoolIntersect, copy);
                        if (B(a, "delete_tools", true))
                            other.Erase();
                    }
                    answer = Info(first);
                    break;
                }
            case "extrude_3d":
            case "revolve_3d":
            case "sweep_3d":
            case "loft_3d":
                {
                    var s = new Solid3d();
                    if (op == "extrude_3d")
                        s.CreateExtrudedSolid(E(tr, db, S(a, "handle")), V(a, "direction", Vector3d.ZAxis).GetNormal() * Positive(N(a, "height")), new SweepOptions());
                    if (op == "revolve_3d")
                        s.CreateRevolvedSolid(E(tr, db, S(a, "handle")), P(a, "axis_point"), V(a, "axis"), N(a, "angle", 360) * Math.PI / 180, 0, new RevolveOptions());
                    if (op == "sweep_3d")
                    {
                        var builder = new SweepOptionsBuilder { Align = SweepOptionsAlignOption.AlignSweepEntityToPath };
                        s.CreateSweptSolid(E(tr, db, S(a, "handle")), E(tr, db, S(a, "path_handle")), builder.ToSweepOptions());
                    }
                    if (op == "loft_3d")
                        s.CreateLoftedSolid(H(a).Select(h => E(tr, db, h)).ToArray(), Array.Empty<Entity>(), null, new LoftOptions());
                    added.Add(Add(s));
                    break;
                }
            case "slice_3d":
                {
                    var s = (Solid3d)E(tr, db, S(a, "handle"), OpenMode.ForWrite);
                    var other = s.Slice(new Plane(P(a, "point"), V(a, "normal")), B(a, "keep_both", true));
                    if (other != null)
                        added.Add(Add(other));
                    answer = Info(s);
                    break;
                }
            case "get_topology":
                {
                    var s = (Solid3d)E(tr, db, S(a, "handle"));
                    using var br = new Brep(new FullSubentityPath(new[] { s.ObjectId }, SubentityId.Null));
                    answer = new
                    {
                        faces = br.Faces.Select(f => new { id = f.SubentityPath.SubentId.IndexPtr.ToInt64() }).ToArray(),
                        edges = br.Edges.Select(e => new { id = e.SubentityPath.SubentId.IndexPtr.ToInt64(), vertices = new[] { XYZ(e.Vertex1.Point), XYZ(e.Vertex2.Point) } }).ToArray()
                    };
                    break;
                }
            case "shell_3d":
            case "fillet_3d":
            case "chamfer_3d":
                {
                    var s = (Solid3d)E(tr, db, S(a, "handle"), OpenMode.ForWrite);
                    var ids = A(a, "indices", Array.Empty<double>()).Select(i => new SubentityId(op == "shell_3d" ? SubentityType.Face : SubentityType.Edge, new IntPtr((long)i))).ToArray();
                    if (op == "shell_3d")
                        s.ShellBody(ids, N(a, "thickness", -1));
                    if (op == "fillet_3d")
                        s.FilletEdges(ids, new DoubleCollection(ids.Select(_ => Positive(N(a, "radius"))).ToArray()), new DoubleCollection(ids.Select(_ => 0.0).ToArray()), new DoubleCollection(ids.Select(_ => 0.0).ToArray()));
                    if (op == "chamfer_3d")
                        s.ChamferEdges(ids, new SubentityId(SubentityType.Face, new IntPtr((long)N(a, "face_index"))), Positive(N(a, "distance", 1)), Positive(N(a, "other_distance", N(a, "distance", 1))));
                    answer = Info(s);
                    break;
                }
            case "move_3d":
            case "rotate_3d":
            case "mirror_3d":
            case "rotate_geometry":
            case "scale_geometry":
            case "mirror_geometry":
                {
                    Matrix3d m = op switch
                    {
                        "move_3d" => Matrix3d.Displacement(V(a, "vector", new Vector3d(0, 0, 0))),
                        "scale_geometry" => Matrix3d.Scaling(Positive(N(a, "factor")), P(a, "center")),
                        "mirror_3d" => Matrix3d.Mirroring(new Plane(P(a, "point"), V(a, "normal"))),
                        "mirror_geometry" => Matrix3d.Mirroring(new Line3d(P(a, "start"), P(a, "end"))),
                        _ => Matrix3d.Rotation(N(a, "angle") * Math.PI / 180, V(a, "axis"), P(a, "center"))
                    };
                    foreach (var h in H(a))
                    {
                        var e = E(tr, db, h, OpenMode.ForWrite);
                        if (B(a, "copy"))
                        {
                            var c = (Entity)e.Clone();
                            c.TransformBy(m);
                            added.Add(Add(c));
                        }
                        else
                            e.TransformBy(m);
                    }
                    answer = new
                    {
                        entities = H(a).Select(h => Info(E(tr, db, h))).ToArray()
                    };
                    break;
                }
            case "array_geometry":
                {
                    int rows = (int)N(a, "rows", 1), cols = (int)N(a, "columns", 1);
                    if (rows < 1 || cols < 1 || rows * cols > 1000)
                        throw new Exception("Array size out of range");
                    foreach (var h in H(a))
                        for (int i = 0; i < rows; i++)
                            for (int j = 0; j < cols; j++)
                            {
                                if (i == 0 && j == 0)
                                    continue;
                                var c = (Entity)E(tr, db, h).Clone();
                                c.TransformBy(Matrix3d.Displacement(new Vector3d(j * N(a, "dx"), i * N(a, "dy"), 0)));
                                added.Add(Add(c));
                            }
                    break;
                }
            case "offset_geometry":
                {
                    foreach (var obj in ((Curve)E(tr, db, S(a, "handle"))).GetOffsetCurves(N(a, "distance")))
                        added.Add(Add((Entity)obj));
                    break;
                }
            case "trim_geometry":
                {
                    var c = (Curve)E(tr, db, S(a, "handle"), OpenMode.ForWrite);
                    var segments = c.GetSplitCurves(new DoubleCollection(A(a, "parameters")));
                    int keep = (int)N(a, "keep_segment");
                    if (keep < 0 || keep >= segments.Count)
                        throw new Exception("Invalid segment");
                    for (int i = 0; i < segments.Count; i++)
                    {
                        if (i == keep)
                            added.Add(Add((Entity)segments[i]));
                        else
                            segments[i].Dispose();
                    }
                    c.Erase();
                    break;
                }
            case "extend_geometry":
                {
                    var c = (Curve)E(tr, db, S(a, "handle"), OpenMode.ForWrite);
                    c.Extend(B(a, "at_start"), P(a, "point"));
                    answer = Info(c);
                    break;
                }
            case "fillet_geometry":
            case "chamfer_geometry":
                {
                    // Exact planar two-line corner construction with the kept endpoints supplied by the caller.
                    var l1 = (Line)E(tr, db, S(a, "first"), OpenMode.ForWrite);
                    var l2 = (Line)E(tr, db, S(a, "second"), OpenMode.ForWrite);
                    var corner = P(a, "corner");
                    var p1 = P(a, "keep_first");
                    var p2 = P(a, "keep_second");
                    var u = (p1 - corner).GetNormal();
                    var v = (p2 - corner).GetNormal();
                    var angle = u.GetAngleTo(v);
                    if (angle < 1e-6 || Math.Abs(angle - Math.PI) < 1e-6 || Math.Abs(u.Z) > 1e-8 || Math.Abs(v.Z) > 1e-8)
                        throw new Exception("Requires non-collinear XY lines");
                    bool Matches(Line line, Point3d kept) => (line.StartPoint.DistanceTo(corner) < 1e-8 && line.EndPoint.DistanceTo(kept) < 1e-8) || (line.EndPoint.DistanceTo(corner) < 1e-8 && line.StartPoint.DistanceTo(kept) < 1e-8);
                    if (l1.ObjectId == l2.ObjectId || !Matches(l1, p1) || !Matches(l2, p2))
                        throw new Exception("Corner and kept endpoints must match two actual lines");
                    double d = op == "fillet_geometry" ? Positive(N(a, "radius")) / Math.Tan(angle / 2) : Positive(N(a, "distance"));
                    if (d > p1.DistanceTo(corner) || d > p2.DistanceTo(corner))
                        throw new Exception("Corner modification exceeds line length");
                    var t1 = corner + u * d;
                    var t2 = corner + v * d;
                    l1.StartPoint = p1;
                    l1.EndPoint = t1;
                    l2.StartPoint = p2;
                    l2.EndPoint = t2;
                    if (op == "chamfer_geometry")
                        added.Add(Add(new Line(t1, t2)));
                    else
                    {
                        double r = N(a, "radius");
                        var center = corner + (u + v).GetNormal() * (r / Math.Sin(angle / 2));
                        double aa = Math.Atan2(t1.Y - center.Y, t1.X - center.X), bb = Math.Atan2(t2.Y - center.Y, t2.X - center.X);
                        if ((bb - aa + 2 * Math.PI) % (2 * Math.PI) > Math.PI)
                            (aa, bb) = (bb, aa);
                        added.Add(Add(new Arc(center, r, aa, bb)));
                    }
                    break;
                }
            case "add_text":
                added.Add(Add(new DBText { Position = P(a, "position"), TextString = S(a, "text"), Height = Positive(N(a, "height", 3)) }));
                break;
            case "add_mtext":
                added.Add(Add(new MText { Location = P(a, "position"), Contents = S(a, "text"), TextHeight = Positive(N(a, "height", 3)), Width = Positive(N(a, "width", 80)) }));
                break;
            case "add_dimension":
            case "add_linear_dimension":
                added.Add(Add(new RotatedDimension(N(a, "angle") * Math.PI / 180, P(a, "first"), P(a, "second"), P(a, "position"), S(a, "text"), db.Dimstyle)));
                break;
            case "add_aligned_dimension":
                added.Add(Add(new AlignedDimension(P(a, "first"), P(a, "second"), P(a, "position"), S(a, "text"), db.Dimstyle)));
                break;
            case "add_radius_dimension":
                added.Add(Add(new RadialDimension(P(a, "center"), P(a, "point"), N(a, "leader", 5), S(a, "text"), db.Dimstyle)));
                break;
            case "add_diameter_dimension":
                added.Add(Add(new DiametricDimension(P(a, "first"), P(a, "second"), N(a, "leader", 5), S(a, "text"), db.Dimstyle)));
                break;
            case "add_angular_dimension":
                added.Add(Add(new LineAngularDimension2(P(a, "first_start"), P(a, "first_end"), P(a, "second_start"), P(a, "second_end"), P(a, "position"), S(a, "text"), db.Dimstyle)));
                break;
            case "create_layer":
            case "set_layer":
                {
                    var layers = (LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead);
                    string name = S(a, "name");
                    if (!layers.Has(name))
                    {
                        if (op == "set_layer")
                            throw new Exception("Layer does not exist");
                        layers.UpgradeOpen();
                        var layer = new LayerTableRecord { Name = name, Color = Autodesk.AutoCAD.Colors.Color.FromColorIndex(Autodesk.AutoCAD.Colors.ColorMethod.ByAci, (short)N(a, "color", 7)) };
                        layers.Add(layer);
                        tr.AddNewlyCreatedDBObject(layer, true);
                    }
                    if (op == "set_layer")
                        db.Clayer = layers[name];
                    answer = new
                    {
                        name
                    };
                    break;
                }
            case "set_color":
            case "set_line_width":
            case "set_line_type":
                {
                    foreach (var h in H(a))
                    {
                        var e = E(tr, db, h, OpenMode.ForWrite);
                        if (op == "set_color")
                            e.ColorIndex = (int)N(a, "color");
                        if (op == "set_line_width")
                            e.LineWeight = (LineWeight)(int)N(a, "hundredths_mm", 25);
                        if (op == "set_line_type")
                            e.Linetype = S(a, "name", "Continuous");
                    }
                    answer = new
                    {
                        entities = H(a).Select(h => Info(E(tr, db, h))).ToArray()
                    };
                    break;
                }
            case "create_block":
                {
                    var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForWrite);
                    string name = S(a, "name");
                    if (bt.Has(name))
                        throw new Exception("Block exists");
                    var block = new BlockTableRecord { Name = name, Origin = P(a, "origin") };
                    bt.Add(block);
                    tr.AddNewlyCreatedDBObject(block, true);
                    foreach (var h in H(a))
                    {
                        var c = (Entity)E(tr, db, h).Clone();
                        block.AppendEntity(c);
                        tr.AddNewlyCreatedDBObject(c, true);
                    }
                    answer = new
                    {
                        name
                    };
                    break;
                }
            case "insert_block":
                {
                    var bt = (BlockTable)tr.GetObject(db.BlockTableId, OpenMode.ForRead);
                    var br = new BlockReference(P(a, "position"), bt[S(a, "name")]) { ScaleFactors = new Scale3d(Positive(N(a, "scale", 1))), Rotation = N(a, "angle") * Math.PI / 180 };
                    added.Add(Add(br));
                    break;
                }
            case "get_entities":
            case "get_entity_count":
            case "get_drawing_bounds":
            case "inspect_drawing":
            case "inspect_3d_model":
                {
                    var entities = ms.Cast<ObjectId>().Select(id => (Entity)tr.GetObject(id, OpenMode.ForRead)).ToArray();
                    var selected = entities.Where(e => S(a, "type") == "" || e.GetType().Name == S(a, "type")).ToArray();
                    var invalid = new List<string>();
                    foreach (var s in entities.OfType<Solid3d>())
                    {
                        if (s.IsNull || s.MassProperties.Volume <= 0)
                            invalid.Add(s.Handle.ToString());
                    }
                    answer = new
                    {
                        count = selected.Length,
                        solid_count = entities.OfType<Solid3d>().Count(),
                        invalid_solids = invalid,
                        entities = selected.Select(Info).ToArray(),
                        units = db.Insunits.ToString(),
                        duplicate_check = "exact type+layer+bounds candidates only; confirm geometry before removing"
                    };
                    break;
                }
            case "get_entity_properties":
            case "get_entity_coordinates":
            case "get_entity_dimensions":
            case "get_3d_solid_information":
                answer = Info(E(tr, db, S(a, "handle")));
                break;
            case "check_interference":
                answer = new
                {
                    interferes = ((Solid3d)E(tr, db, S(a, "first"))).CheckInterference((Solid3d)E(tr, db, S(a, "second")))
                };
                break;
            case "get_layer_information":
                answer = ((LayerTable)tr.GetObject(db.LayerTableId, OpenMode.ForRead)).Cast<ObjectId>().Select(id => { var l = (LayerTableRecord)tr.GetObject(id, OpenMode.ForRead); return new { name = l.Name, color = l.Color.ColorIndex, locked = l.IsLocked, off = l.IsOff }; }).ToArray();
                break;
            case "delete_entities":
                foreach (var h in H(a))
                    E(tr, db, h, OpenMode.ForWrite).Erase();
                answer = new
                {
                    deleted = H(a)
                };
                break;
            case "repair_entity":
                {
                    var e = E(tr, db, S(a, "handle"), OpenMode.ForWrite);
                    if (e is Solid3d so)
                        so.CleanBody();
                    else if (e is Polyline pl && S(a, "action") == "close_polyline")
                        pl.Closed = true;
                    else
                        throw new Exception("Repair not supported for this entity/action");
                    answer = Info(e);
                    break;
                }
            default:
                throw new Exception("Unknown operation " + op);
        }
        if (added.Count > 0)
            answer = new
            {
                handles = added,
                entities = added.Select(h => Info(E(tr, db, h))).ToArray(),
                result = answer
            };
        tr.Commit();
        ed.Regen();
        return answer ?? new
        {
            completed = true
        };
    }
}
