"""Original, parameterized industrial pilot references. CAD coordinates: mm, Z up.
Creates exact STEP, STL, face-aware render mesh JSON and intake metadata.
"""
import json, math, hashlib, sys
from pathlib import Path
import cadquery as cq
import trimesh
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepAdaptor import BRepAdaptor_Surface

ROOT = Path(__file__).resolve().parents[2]
PARTS = ROOT / 'parts'
FEATURES = []
CHECKS = []

def box(w,d,h,center=(0,0,0)):
    return cq.Workplane('XY').box(w,d,h,centered=(True,True,False)).translate(center)
def cyl(r,h,p=(0,0,0),axis=(0,0,1)):
    return cq.Workplane(obj=cq.Solid.makeCylinder(r,h,cq.Vector(*p),cq.Vector(*axis)))
def cone(r1,r2,h,p,axis=(0,0,1)):
    return cq.Workplane(obj=cq.Solid.makeCone(r1,r2,h,cq.Vector(*p),cq.Vector(*axis)))
def rounded(w,d,h,r,p=(0,0,0)):
    return box(w,d,h,p).edges('|Z').fillet(r)
def feature(fid,kind,center,axis=(0,0,1),**kw):
    FEATURES.append(dict(id=fid,type=kind,center=list(center),axis=list(axis),**kw))
def hole(body,fid,diam,depth,entry,axis=(0,0,-1),counter=None):
    ax=cq.Vector(*axis); origin=cq.Vector(*entry)-ax*0.02
    body=body.cut(cyl(diam/2,depth+.04,origin.toTuple(),axis))
    body=body.cut(cone(diam/2+.35,diam/2,.35,entry,axis))
    kind='through-hole' if fid.startswith('mount') or fid.startswith('bore') else 'blind-hole'
    feature(fid,kind,entry,axis,diameter=diam,depth=depth,entryChamfer=.35)
    if counter:
        cd,dep=counter;body=body.cut(cyl(cd/2,dep+.02,origin.toTuple(),axis))
        body=body.cut(cone(cd/2+.35,cd/2,.35,entry,axis))
        FEATURES[-1]['counterbore']={'diameter':cd,'depth':dep}
    CHECKS.append({'name':fid+' axis void','point':(cq.Vector(*entry)+ax*min(depth/2,3)).toTuple(),'inside':False})
    return body

def fixture():
    s=rounded(160,100,38,6).faces('>Z').edges().chamfer(.8)
    # Two-level pocket with tool-radius corners and a retained location island.
    s=s.cut(rounded(98,52,13,6,(0,0,26)))
    s=s.cut(rounded(80,36,19,4,(0,0,20)))
    s=s.union(rounded(18,14,7,2,(0,0,20)))
    feature('stepped-pocket','pocket',(0,0,38),width=98,length=52,depth=18,cornerRadius=6)
    feature('location-island','boss',(0,0,20),width=18,length=14,height=7)
    for x in [-65,65]:
        for y in [-35,35]:s=hole(s,f'mount-{x}-{y}',9,38,(x,y,38),counter=(16,8))
    for x in [-30,30]:s=hole(s,f'dowel-floor-{x}',6,10,(x,0,20))
    for x in [-39,39]:s=hole(s,f'front-cross-bore-{x}',8,24,(x,-50,12),(0,1,0))
    s=hole(s,'hidden-rear-port',7,16,(0,50,15),(0,-1,0))
    # Two registration holes on the unpocketed top land.
    for x in [-26,26]:s=hole(s,f'top-dowel-{x}',5,12,(x,38,38))
    for x in [-80,80]:
        s=s.cut(box(4,36,9,(x,0,5)))
    CHECKS.extend([{'name':'island retained','point':(0,0,24),'inside':True}, {'name':'pocket open','point':(20,0,30),'inside':False}])
    return s,'Machined fixture block','prismatic-machined','aluminium, precision machined',[160,100,38],'aluminium'

def flange():
    s=cyl(75,16).edges().fillet(.7)
    hub=cyl(45,24,(0,0,16)).faces('>Z').edges().chamfer(1)
    s=s.union(hub)
    s=s.edges().filter(lambda e:e.geomType()=='CIRCLE' and abs(e.radius()-45)<.01 and abs(e.Center().z-16)<.01).fillet(3)
    s=hole(s,'bore-central',48,40,(0,0,40),counter=(55,5))
    # Face seal groove, rear annular lightening recess and asymmetric dowel.
    groove=cyl(36,2.3,(0,0,37.8)).cut(cyl(33,3,(0,0,37.5)))
    s=s.cut(groove)
    rear=cyl(51,3.2,(0,0,-.1)).cut(cyl(38,3.5,(0,0,-.2)))
    s=s.cut(rear)
    feature('face-seal-groove','annular-groove',(0,0,40),innerDiameter=66,outerDiameter=72,depth=2.2)
    feature('hidden-rear-recess','annular-pocket',(0,0,0),(0,0,-1),innerDiameter=76,outerDiameter=102,depth=3.1)
    for i in range(8):
        a=2*math.pi*i/8;x,y=60*math.cos(a),60*math.sin(a)
        # M10 socket head cap screws (ISO 4762): Ø10.5 clearance, Ø17.5 counterbore.
        s=hole(s,f'mount-bolt-{i+1}',10.5,16,(x,y,16),counter=(17.5,5.5))
    a=math.pi/8;s=hole(s,'index-dowel',4,9,(67*math.cos(a),67*math.sin(a),16))
    s=hole(s,'radial-service-port',6,24,(45,0,28),(-1,0,0))
    FEATURES[-1]['type']='radial-port'
    CHECKS.append({'name':'hub wall retained','point':(40,10,24),'inside':True})
    return s,'Flanged shaft adapter','turned','steel, turned and milled',[150,150,40],'steel'

def housing():
    s=rounded(174,74,14,7).faces('>Z').edges().fillet(1.5)
    outer=cyl(43,52,(0,-26,53),(0,1,0))
    s=s.union(outer)
    # Integral casting webs transfer ring load to the feet.
    for sign in [-1,1]:
        poly=[(sign*29,13),(sign*73,13),(sign*41,48)]
        web=cq.Workplane('XZ').polyline(poly).close().extrude(8,both=True)
        s=s.union(web)
    for x in [-66,66]:s=s.union(rounded(34,54,5,4,(x,0,14)))
    s=s.union(cyl(9,14,(0,0,89)).edges('>Z').chamfer(.7))
    # Ø52 bore: seat for a 52 mm OD deep-groove bearing (e.g. 6205); the Ø58 end
    # recesses take seals or covers.
    s=hole(s,'bore-bearing',52,52,(0,-26,53),(0,1,0),counter=(58,8))
    FEATURES[-1]['note']='bearing seat for a 52 mm OD bearing; front counterbore is a seal/cover recess'
    s=s.cut(cyl(29,6.02,(0,26.01,53),(0,-1,0)))
    groove=cyl(33,1.8,(0,-26.01,53),(0,1,0)).cut(cyl(31,2,(0,-26.1,53),(0,1,0)))
    s=s.cut(groove)
    feature('front-seal-groove','annular-groove',(0,-26,53),(0,-1,0),innerDiameter=62,outerDiameter=66,depth=1.8)
    feature('rear-seal-recess','counterbore',(0,26,53),(0,-1,0),diameter=58,depth=6)
    for x in [-66,66]:
        slot=cq.Workplane('XY').center(x,0).slot2D(30,11,angle=90).extrude(22).translate((0,0,-1))
        s=s.cut(slot)
        seat=cq.Workplane('XY').center(x,0).slot2D(35,19,angle=90).extrude(4.2).translate((0,0,15))
        s=s.cut(seat)
        feature(f'mount-slot-{x}','slot',(x,0,19),length=30,width=11,depth=19,counterboreWidth=19,counterboreDepth=4)
        CHECKS.append({'name':f'slot-{x} open','point':(x,0,8),'inside':False})
    # The lubrication port runs from the crown into the bore (it opens 2 mm into it).
    s=hole(s,'lubrication-port',5,26,(0,0,103))
    FEATURES[-1].update(type='cross-port',opensInto='bore-bearing')
    # Cover fixings at r=38: 3 mm wall to the seal groove (r=33) and to the outside (r=43).
    for x in [-38,38]:s=hole(s,f'cover-fixing-{x}',4,10,(x,-26,53),(0,1,0))
    CHECKS.append({'name':'housing crown retained','point':(6,0,91),'inside':True})
    return s,'Ribbed bearing housing','cast','cast iron, blue enamel with machined seats',[174,74,103],'cast-blue'

def sheet():
    # A true constant-thickness folded strip: inside radius 4, outside radius 7.
    base=(cq.Workplane('XY').moveTo(-54,-40).lineTo(54,-40)
      .threePointArc((58.243,-38.243),(60,-34)).lineTo(60,32).lineTo(-60,32).lineTo(-60,-34)
      .threePointArc((-58.243,-38.243),(-54,-40)).close().extrude(3))
    bottom=(cq.Workplane('YZ',origin=(-60,0,0)).moveTo(32,0)
      .threePointArc((36.949747,2.050253),(39,7)).lineTo(36,7)
      .threePointArc((34.828427,4.171573),(32,3)).close().extrude(120))
    wall=box(120,3,93,(0,37.5,7))
    top=(cq.Workplane('YZ',origin=(-60,0,0)).moveTo(39,100)
      .threePointArc((36.949747,104.949747),(32,107)).lineTo(32,104)
      .threePointArc((34.828427,102.828427),(36,100)).close().extrude(120))
    # Top flange 24 mm deep (y 8..32) so its holes keep 2t+R from the bend and 2.5t to the edge.
    s=base.union(bottom).union(wall).union(top).union(box(120,24,3,(0,20,104)))
    for x in [-43,43]:
        slot=cq.Workplane('XY').center(x,-15).slot2D(24,7,angle=90).extrude(5).translate((0,0,-1));s=s.cut(slot)
        feature(f'mount-slot-{x}','slot',(x,-15,3),length=24,width=7,depth=3)
        CHECKS.append({'name':f'slot-{x} open','point':(x,-15,1.5),'inside':False})
    for i in range(7):
        z=28+8*i
        slot=cq.Workplane('XZ',origin=(0,40,z)).slot2D(66,4).extrude(5)
        s=s.cut(slot);feature(f'vent-{i+1}','slot',(0,39,z),(0,-1,0),length=66,width=4,depth=3)
    # Sensor bore 11 mm below the upper bend tangent (z=100) and 5 mm from the vent slots.
    s=hole(s,'bore-sensor',16,3,(-46,39,81),(0,-1,0))
    for x in [-42,42]:s=hole(s,f'mount-top-{x}',4.5,3,(x,18,107))
    center=cq.Workplane('XY').center(0,-9).slot2D(44,18).extrude(5).translate((0,0,-1));s=s.cut(center)
    feature('base-cable-opening','slot',(0,-9,3),length=44,width=18,depth=3)
    feature('lower-bend','bend',(0,32,7),(1,0,0),insideRadius=4,outsideRadius=7,angle=90,thickness=3)
    feature('upper-bend','bend',(0,32,100),(1,0,0),insideRadius=4,outsideRadius=7,angle=90,thickness=3)
    CHECKS.append({'name':'web retained','point':(50,37.5,50),'inside':True})
    return s,'Folded sensor and cable mount','sheet-metal','steel sheet, satin graphite powder coat',[120,79,107],'graphite'

def material(face,style):
    if style!='cast-blue':return style
    c=face.Center();typ=face.geomType()
    if typ=='PLANE' and (abs(abs(c.y)-26)<.1 or abs(c.z-19)<.1 or abs(c.z-15)<.1):return 'steel'
    if typ=='CYLINDER':
        radius=BRepAdaptor_Surface(face.wrapped).Cylinder().Radius()
        if abs(radius-43)>1 and abs(radius-9)>1:return 'steel'
    return style

def build(fid,fn):
    FEATURES.clear();CHECKS.clear()
    s,name,category,finish,dimensions,style=fn();s=s.clean();shape=s.val()
    if not shape.isValid() or len(s.solids().vals())!=1:raise RuntimeError(f'{fid}: invalid or disconnected CAD')
    checks=[]
    for check in CHECKS:
        actual=shape.isInside(cq.Vector(*check['point']),1e-5)
        checks.append(dict(check,actualInside=actual,passed=actual==check['inside']))
    if not all(c['passed'] for c in checks):raise RuntimeError(f'{fid}: feature validation failed {checks}')
    folder=PARTS/fid;folder.mkdir(parents=True,exist_ok=True)
    cq.exporters.export(s,str(folder/'model.step'))
    cq.exporters.export(s,str(folder/'model.stl'),tolerance=.035,angularTolerance=.075)
    # Per CAD face mesh patches preserve flat faces and hard machined edges in Blender.
    patches=[]
    for f in shape.Faces():
        vs,ts=f.tessellate(.035,.075)
        patches.append({'vertices':[v.toTuple() for v in vs],'normals':[f.normalAt(v).toTuple() for v in vs],'triangles':ts,'smooth':f.geomType()!='PLANE','material':material(f,style)})
    (folder/'render-mesh.json').write_text(json.dumps({'units':'mm','up':'Z','patches':patches}),encoding='utf8')
    mesh=trimesh.load_mesh(folder/'model.stl',process=True)
    mesh.merge_vertices();mesh.remove_unreferenced_vertices()
    bb=Bnd_Box();BRepBndLib.AddOptimal_s(shape.wrapped,bb,False,False)
    bounds=bb.Get();size=[bounds[i+3]-bounds[i] for i in range(3)]
    rel=abs(abs(mesh.volume)-shape.Volume())/shape.Volume()
    quality={'cadValid':shape.isValid(),'solidCount':len(s.solids().vals()),'cadVolumeMm3':shape.Volume(),'cadDimensionsMm':size,'stlWatertight':bool(mesh.is_watertight),'stlWindingConsistent':bool(mesh.is_winding_consistent),'stlTriangles':len(mesh.faces),'meshCadVolumeRelativeError':rel,'featureChecks':checks,'declaredDimensionCheck':all(abs(a-b)<.02 for a,b in zip(size,dimensions))}
    if not quality['stlWatertight'] or not quality['declaredDimensionCheck'] or rel>.005:raise RuntimeError(f'{fid}: failed QA {quality}')
    meta={'id':fid,'name':name,'category':category,'units':'mm','declaredSize':dict(zip(['length','width','height'],dimensions)),'declaredSizeSource':'original design parameters; synthetic nominal dimensions, not independently measured AAS values','material':finish,'restingFaces':[[0,0,-1]],'features':list(FEATURES),'release':'public','source':'Original parametric synthetic design created for this evaluation; not a manufacturer model or certified standard part.','notes':'Held-out test part, reviewed against common design rules before any reconstruction existed.','cadCoordinateSystem':{'up':'Z','units':'mm','origin':'XY center, resting base Z=0'},'meshCoordinateSystem':{'file':'model.glb','up':'Y','units':'m','fromCad':'[x,y,z] mm -> [x,z,-y] / 1000 m'},'evaluationStatus':'held-out test part (protocol/PROTOCOL.md); not used for method development','modelFiles':{'cad':'model.step','mesh':'model.glb','triangulatedCad':'model.stl','preview':'preview.png'},'annotationsPolicy':'CAD and feature inventory are evaluator-only; explicitly specify any fields made available to the agent.','threadPolicy':'Ports are modeled as smooth bores; no thread standard or thread accuracy is asserted.'}
    (folder/'part.json').write_text(json.dumps(meta,indent=2),encoding='utf8')
    (folder/'validation.json').write_text(json.dumps(quality,indent=2),encoding='utf8')
    print(fid,json.dumps({k:v for k,v in quality.items() if k!='featureChecks'}),flush=True)
    return {'id':fid,'name':name,'dimensionsMm':dimensions,'featureCount':len(FEATURES),'style':style,'quality':quality}

if __name__=='__main__':
    fs=[('pilot-fixture-block',fixture),('pilot-flange-adapter',flange),('pilot-bearing-housing',housing),('pilot-sheet-metal-mount',sheet)]
    if len(sys.argv)>1:fs=[x for x in fs if x[0] in sys.argv[1:]]
    records=[build(fid,fn) for fid,fn in fs]
    target=ROOT/'pilot';target.mkdir(exist_ok=True)
    (target/'build-summary.json').write_text(json.dumps({'cadqueryVersion':cq.__version__,'parts':records},indent=2),encoding='utf8')
