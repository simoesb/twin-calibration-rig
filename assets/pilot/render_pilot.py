"""Blender background renderer. Reads CAD tessellation; exports metric Y-up GLBs.
Appearance nodes add microroughness only, never alter benchmark geometry.
"""
import bpy, json, math, sys
from pathlib import Path
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[2]
PARTS=ROOT/'parts';OUT=ROOT/'pilot';OUT.mkdir(exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene=bpy.context.scene
scene.render.engine='CYCLES';scene.cycles.samples=96;scene.cycles.use_denoising=True
scene.cycles.adaptive_threshold=.015
scene.render.resolution_x=1800;scene.render.resolution_y=1400;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.view_settings.view_transform='AgX'
scene.view_settings.exposure=-.6
scene.render.film_transparent=False
scene.unit_settings.system='METRIC';scene.unit_settings.scale_length=1
prefs=bpy.context.preferences.addons['cycles'].preferences
try:
    prefs.compute_device_type='CUDA';prefs.get_devices()
    for d in prefs.devices:d.use=d.type=='CUDA'
    scene.cycles.device='GPU'
except Exception:scene.cycles.device='CPU'
scene.world=bpy.data.worlds.new('Neutral studio environment');scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.63,.69,.78,1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=.32

def mat(name,color,metal,rough,texture=True):
    m=bpy.data.materials.new(name);m.use_nodes=True
    ns=m.node_tree.nodes;ls=m.node_tree.links;p=ns.get('Principled BSDF')
    p.inputs['Base Color'].default_value=(*color,1);p.inputs['Metallic'].default_value=metal;p.inputs['Roughness'].default_value=rough
    if 'Anisotropic IOR Level' in p.inputs:p.inputs['Anisotropic IOR Level'].default_value=.35 if metal>.8 else 0
    if texture:
        coord=ns.new('ShaderNodeTexCoord');noise=ns.new('ShaderNodeTexNoise');noise.inputs['Scale'].default_value=240;noise.inputs['Detail'].default_value=2
        ls.new(coord.outputs['Generated'],noise.inputs['Vector'])
        bump=ns.new('ShaderNodeBump');bump.inputs['Strength'].default_value=.12 if name=='cast-blue' else .055;bump.inputs['Distance'].default_value=.000055 if name=='cast-blue' else .000012
        ls.new(noise.outputs['Fac'],bump.inputs['Height']);ls.new(bump.outputs['Normal'],p.inputs['Normal'])
        ramp=ns.new('ShaderNodeMapRange');ramp.inputs['From Min'].default_value=0;ramp.inputs['From Max'].default_value=1;ramp.inputs['To Min'].default_value=rough-.045;ramp.inputs['To Max'].default_value=rough+.045
        ls.new(noise.outputs['Fac'],ramp.inputs['Value']);ls.new(ramp.outputs['Result'],p.inputs['Roughness'])
    return m
mats={'aluminium':mat('aluminium',(.58,.63,.69),1,.28),'steel':mat('steel',(.40,.45,.51),1,.235),'cast-blue':mat('cast-blue',(.005,.035,.08),.15,.40),'graphite':mat('graphite',(.018,.023,.030),.10,.48)}
groundmat=mat('Warm studio surface',(.68,.66,.61),0,.7,False)

def aim(obj,target):obj.rotation_euler=(Vector(target)-obj.location).to_track_quat('-Z','Y').to_euler()
def light(name,pos,energy,size,color,shape='DISK',size_y=None):
    d=bpy.data.lights.new(name,'AREA');d.energy=energy;d.shape=shape;d.size=size;d.color=color
    if size_y is not None:d.size_y=size_y
    o=bpy.data.objects.new(name,d);scene.collection.objects.link(o);o.location=pos;aim(o,(0,0,.04));return o
light('Large softbox',(-.28,-.30,.44),22,.32,(1,.94,.86),'RECTANGLE',.22)
light('Cool rim strip',(.23,.18,.35),30,.28,(.82,.90,1),'RECTANGLE',.075)
light('Front fill',(.25,-.32,.19),6,.22,(1,1,1))
bpy.ops.mesh.primitive_plane_add(size=200,location=(0,0,-.00035));ground=bpy.context.object;ground.name='Studio floor';ground.data.materials.append(groundmat)
camd=bpy.data.cameras.new('Product camera');cam=bpy.data.objects.new('Product camera',camd);scene.collection.objects.link(cam);scene.camera=cam;camd.type='ORTHO';camd.lens=65;camd.clip_start=.001

ids=['pilot-fixture-block','pilot-flange-adapter','pilot-bearing-housing','pilot-sheet-metal-mount']
args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
if args:ids=[x for x in ids if x in args]
for fid in ids:
    folder=PARTS/fid;data=json.loads((folder/'render-mesh.json').read_text());meta=json.loads((folder/'part.json').read_text())
    vertices=[];faces=[];indices=[];smooth=[];normals=[];keys=list(mats)
    for patch in data['patches']:
        n=len(vertices);vertices.extend([tuple(x/1000 for x in v) for v in patch['vertices']]);faces.extend([tuple(i+n for i in t) for t in patch['triangles']]);indices.extend([keys.index(patch['material'])]*len(patch['triangles']));smooth.extend([patch['smooth']]*len(patch['triangles']));normals.extend(patch['normals'])
    mesh=bpy.data.meshes.new(fid);mesh.from_pydata(vertices,[],faces);mesh.update()
    obj=bpy.data.objects.new(fid,mesh);scene.collection.objects.link(obj)
    for material in mats.values():mesh.materials.append(material)
    for i,p in enumerate(mesh.polygons):p.material_index=indices[i];p.use_smooth=smooth[i]
    mesh.normals_split_custom_set_from_vertices(normals)
    # Export a portable PBR mesh, keeping finish microroughness in the studio only.
    portable=[]
    for key,m in mats.items():
        copy=m.copy();copy.name=key+'-portable';p=copy.node_tree.nodes.get('Principled BSDF')
        for input_name in ['Normal','Roughness']:
            for link in list(p.inputs[input_name].links):copy.node_tree.links.remove(link)
        portable.append(copy)
    for i,m in enumerate(portable):mesh.materials[i]=m
    bpy.ops.object.select_all(action='DESELECT');obj.select_set(True);bpy.context.view_layer.objects.active=obj
    bpy.ops.export_scene.gltf(filepath=str(folder/'model.glb'),export_format='GLB',use_selection=True,export_yup=True,export_apply=True)
    for i,m in enumerate(mats.values()):mesh.materials[i]=m
    size=max(meta['declaredSize'].values())/1000;h=meta['declaredSize']['height']/1000
    camd.ortho_scale=size*1.70;cam.location=(size*1.7,-size*2.2,size*1.65);aim(cam,(0,0,h*.43))
    if 'sheet-metal' in fid:camd.ortho_scale=size*2.10
    if 'housing' in fid:cam.location=(size*1.35,-size*2.6,size*1.35);aim(cam,(0,0,h*.48))
    scene.render.filepath=str(folder/'preview.png');scene.cycles.seed=71
    bpy.ops.render.render(write_still=True)
    # Rear view for housings/mount; underside inspection for flange/fixture.
    if 'flange' in fid or 'fixture' in fid:
        obj.rotation_euler.x=math.pi;obj.location.z=h;cam.location=(-size*1.6,-size*2.2,size*1.65)
    else:cam.location=(-size*1.7,size*2.2,size*1.55)
    aim(cam,(0,0,h*.45));scene.render.filepath=str(folder/'reverse.png');scene.cycles.seed=72
    bpy.ops.render.render(write_still=True)
    obj.rotation_euler=(0,0,0);obj.location=(0,0,0)
    # Editable per-part studio file, preserving the actual geometry and lighting.
    cam.location=(size*1.7,-size*2.2,size*1.65);aim(cam,(0,0,h*.43));scene.render.filepath=str(folder/'preview.png')
    bpy.ops.wm.save_as_mainfile(filepath=str(folder/'studio.blend'))
    bpy.data.objects.remove(obj,do_unlink=True)
    print('PILOT_FINISHED',fid,flush=True)
