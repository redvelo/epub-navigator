use epub_navigator::kernel::{
    DocumentAdapter, NavigatorKernel, OccurrenceDocumentTarget, project_reading_order,
};
use epub_stack::EpubZip;
use std::{fs::File, io::BufReader};

#[test]
fn official_roll_archives_project_native_and_json_without_text_fallbacks() {
    for (fixture, direct_images) in [
        ("lay-roll-images-in-spine", true),
        ("lay-roll-images-mixed", true),
        ("lay-roll-embedded-images", false),
        ("lay-roll-embedded-images-svg", false),
    ] {
        let path = format!(
            "{}/../../tests/fixtures/epub34/{fixture}.epub",
            env!("CARGO_MANIFEST_DIR")
        );
        let epub = EpubZip::from_reader(BufReader::new(File::open(path).unwrap()))
            .unwrap()
            .default_rendition()
            .unwrap();
        let facts = epub_navigator::facts::PublicationFacts::of(&epub).unwrap();
        let typed = project_reading_order(&facts).unwrap();
        let facts_json = serde_json::to_value(&facts).unwrap();
        let kernel = NavigatorKernel::create(&serde_json::json!({
            "facts": facts_json,
            "mount": { "baseUrl": "https://publication.test/", "contentOrigin": "isolated-publication-origin", "remoteResources": "blocked" }
        }).to_string()).unwrap();
        assert_eq!(typed, kernel.snapshot().reading_order, "{fixture}");

        let mut images = 0;
        for occurrence in &typed {
            let declaration = facts_json["resources"]["readingOrder"][occurrence.ordinal as usize]
                ["target"]["value"]
                .as_u64()
                .unwrap();
            let authored_image = facts_json["package"]["manifest"]["items"][declaration as usize]["mediaType"]
                == "image/png";
            let OccurrenceDocumentTarget::Loadable { adapter, .. } = occurrence.document else {
                panic!("{fixture} occurrence is not loadable");
            };
            assert_eq!(
                adapter == DocumentAdapter::FixedImage,
                authored_image,
                "{fixture}"
            );
            if authored_image {
                assert_eq!(occurrence.selected_declaration, Some(declaration as u32));
                images += 1;
            }
        }
        assert_eq!(images > 0, direct_images, "{fixture}");
    }
}
