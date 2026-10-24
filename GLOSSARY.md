# Family Photos

Tools for understanding a family's photo collection. The first is a viewer that shows one Photo alongside everything recorded about it.

## Language

### The photo and what it carries

**Photo**:
A single image file the user opens, together with all the metadata embedded in it.
_Avoid_: Image, picture, file

**Section**:
A group of Fields that share one origin standard: File, EXIF, GPS, IPTC, XMP, ICC, or Maker notes.
_Avoid_: Category, group, block, tag group

**Field**:
One named piece of metadata within a Section, such as exposure time or caption.
_Avoid_: Tag, property, attribute, key

**Tag name**:
ExifTool's exact identifier for a Field, such as "ExposureTime", as opposed to the Field's readable label.
_Avoid_: Key, field ID

**Raw value**:
A Field's value exactly as stored in the Photo.
_Avoid_: Original value, source value

**Display value**:
A Field's value rendered for people, such as "1/250 s" for a Raw value of 0.004; shown only where it differs from the Raw value.
_Avoid_: Formatted value, pretty value, human value

**Maker notes**:
The camera manufacturer's proprietary Section, often undocumented.
_Avoid_: Vendor data, MakerNote tags

### What the viewer works out

**Date taken**:
When the shutter fired, as recorded by the camera, as opposed to when the file was created or last modified.
_Avoid_: Capture date, timestamp, creation date

**Summary**:
A short overview of a Photo derived from its Fields: Date taken and its timezone, camera and lens, exposure, and location.
_Avoid_: Overview, highlights, info card

**Warning**:
A notice derived from a Photo's Fields that something looks wrong or missing, such as stripped metadata.
_Avoid_: Alert, error, issue, flag
