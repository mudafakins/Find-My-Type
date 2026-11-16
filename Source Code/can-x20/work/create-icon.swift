import AppKit
let root = CommandLine.arguments[1]
for (name, size) in [("icon_16x16",16),("icon_16x16@2x",32),("icon_32x32",32),("icon_32x32@2x",64),("icon_128x128",128),("icon_128x128@2x",256),("icon_256x256",256),("icon_256x256@2x",512),("icon_512x512",512),("icon_512x512@2x",1024)] {
 let bitmap = NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:size,pixelsHigh:size,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
 NSGraphicsContext.saveGraphicsState()
 NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep:bitmap)
 let s = CGFloat(size)/1024
 let ctx = NSGraphicsContext.current!.cgContext
 ctx.scaleBy(x:s,y:s)
 let rect = NSRect(x:54,y:54,width:916,height:916)
 let shape = NSBezierPath(roundedRect:rect,xRadius:208,yRadius:208)
 NSGraphicsContext.saveGraphicsState()
 let shadow = NSShadow(); shadow.shadowColor=NSColor(white:0,alpha:0.22); shadow.shadowBlurRadius=20; shadow.shadowOffset=NSSize(width:0,height:-10); shadow.set()
 NSColor(white:0.9,alpha:1).setFill(); shape.fill()
 NSGraphicsContext.restoreGraphicsState()
 NSGradient(starting:NSColor(white:0.84,alpha:1),ending:NSColor(white:0.99,alpha:1))!.draw(in:shape,angle:90)
 NSColor(white:1,alpha:0.9).setStroke(); shape.lineWidth=3; shape.stroke()
 // A precisely drawn serif T: a typographic specimen that stays clear at Dock sizes.
 NSColor(white:0.12,alpha:1).setFill()
 let t=NSBezierPath()
 t.move(to:NSPoint(x:232,y:750)); t.line(to:NSPoint(x:744,y:750))
 t.line(to:NSPoint(x:754,y:600)); t.line(to:NSPoint(x:726,y:600))
 t.curve(to:NSPoint(x:568,y:708),controlPoint1:NSPoint(x:704,y:690),controlPoint2:NSPoint(x:668,y:708))
 t.line(to:NSPoint(x:551,y:708)); t.line(to:NSPoint(x:551,y:361))
 t.curve(to:NSPoint(x:625,y:310),controlPoint1:NSPoint(x:551,y:320),controlPoint2:NSPoint(x:567,y:310))
 t.line(to:NSPoint(x:625,y:280)); t.line(to:NSPoint(x:348,y:280)); t.line(to:NSPoint(x:348,y:310))
 t.curve(to:NSPoint(x:422,y:361),controlPoint1:NSPoint(x:406,y:310),controlPoint2:NSPoint(x:422,y:320))
 t.line(to:NSPoint(x:422,y:708)); t.line(to:NSPoint(x:405,y:708))
 t.curve(to:NSPoint(x:250,y:600),controlPoint1:NSPoint(x:305,y:708),controlPoint2:NSPoint(x:270,y:690))
 t.line(to:NSPoint(x:222,y:600)); t.close(); t.fill()
 // Search badge links the letterform to discovering fonts.
 let badge=NSBezierPath(ovalIn:NSRect(x:640,y:170,width:204,height:204))
 NSColor(white:0.12,alpha:1).setFill(); badge.fill()
 NSColor(white:0.97,alpha:1).setStroke()
 let lens=NSBezierPath(ovalIn:NSRect(x:687,y:237,width:77,height:77)); lens.lineWidth=13; lens.stroke()
 let handle=NSBezierPath(); handle.move(to:NSPoint(x:753,y:246)); handle.line(to:NSPoint(x:789,y:210)); handle.lineWidth=14; handle.lineCapStyle = .round; handle.stroke()
 NSGraphicsContext.restoreGraphicsState()
 try bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:root+"/"+name+".png"))
}
